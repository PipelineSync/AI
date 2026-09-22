'use strict';
/* Shared /api/deliver logic, mounted by netlify/functions/deliver.js and by server.js.
 *
 * Function C  builds the PDF server-side (pure-JS writer in lib/core.js).
 * Phase 3    emails that PDF to the lead through Resend (lib/pdf-email.js), after the PDF is
 *            built and consent was confirmed. The recipient is the address in the HMAC-signed
 *            session token, never the address in the request body, so the attachment cannot be
 *            redirected by editing the unlock form. An email failure is reported as a failure
 *            and never blocks the PDF travelling back to the browser.
 * Function D  pushes the lead to HubSpot (contact + deal + note). The note records how the
 *            email went, so the CRM shows the same truth the browser shows.
 *
 * Both mounts call this one function so the deployed and local paths cannot drift apart.
 * Returns { statusCode, body } plus `meta` for the local outbox (which is dev-server only).
 */
const core = require('./core');
const leads = require('./supabase-leads');
const hubspot = require('./hubspot');
const pdfEmail = require('./pdf-email');
const { checkRateLimit } = require('./netlify-helpers');
const { clampVoiceMeta } = require('./voice-api');

/* 5 unlock attempts per minute per IP (Phase 3). Each one builds a PDF and may send an email,
   and the endpoint is the one place a stranger can make the server spend money, so the limit is
   tighter than the 20/min entry gate. DELIVER_RATE_PER_MIN overrides it (the test suite uses a
   high value so one run does not trip it; the deploy keeps the default). */
const DELIVER_PER_MIN = 5;

function ratePerMinute(env) {
  const n = parseInt(String((env || process.env).DELIVER_RATE_PER_MIN || ''), 10);
  return Number.isFinite(n) && n > 0 ? n : DELIVER_PER_MIN;
}

function checkDeliverRateLimit(ip, env) {
  return checkRateLimit('deliver:' + String(ip || 'unknown'), ratePerMinute(env), 60 * 1000);
}

/* The only address this endpoint will ever email: the one the entry gate validated and the
   token signed. Anything else (a replayed body, an edited form field) is ignored. */
function recipientFromToken(payload) {
  const email = String((payload && payload.email) || '').trim().toLowerCase();
  return pdfEmail.isEmail(email) ? email : null;
}

function logLead(lead) {
  console.log('[hubspot-mock] lead push: ' + JSON.stringify(lead));
}

async function deliver(opts) {
  const o = opts || {};
  const env = o.env || process.env;
  const body = o.body || {};
  const fetchImpl = o.fetchImpl || (typeof globalThis.fetch === 'function' ? globalThis.fetch : null);

  let payload;
  try {
    payload = core.verifyToken(body.token);
  } catch (e) {
    return { statusCode: 500, body: { error: 'Server misconfigured: missing token secret.' } };
  }
  if (!payload) {
    return { statusCode: 401, body: { error: 'Your session has ended. Enter your name and email to start again.' } };
  }

  const bp = body.blueprint;
  if (!bp || !bp.meta || !bp.meta.verticalLabel) {
    return { statusCode: 400, body: { error: 'No blueprint in request. Generate the blueprint before unlocking the PDF.' } };
  }
  const email = String(body.email || '').trim().toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return { statusCode: 400, body: { error: 'Enter a valid email to unlock the PDF.' } };
  }
  if (email.length > 254) return { statusCode: 400, body: { error: 'Email too long.' } };
  if (body.consent !== true) {
    return { statusCode: 400, body: { error: 'Please tick the consent box before we send the PDF.' } };
  }

  // Function C: the real PDF, built inside the function (no npm packages).
  const buffer = core.buildPdf(bp);
  const filename = core.pdfFilename(bp);
  const leadName = core.cleanName(payload.name) || core.loginNameFor(payload.email || email);
  const voiceMeta = clampVoiceMeta(body.voice_meta);
  const mockLead = core.makeLeadPayload(email, leadName, body.fields || null, bp, voiceMeta);

  // Phase 3: email the PDF that was just built. This never throws and never decides the outcome
  // of the request: the browser download is served whatever Resend says.
  const recipient = recipientFromToken(payload);
  const emailResult = await pdfEmail.sendBlueprintEmail({
    to: recipient,
    name: leadName,
    blueprint: bp,
    filename,
    pdfBuffer: buffer,
    env,
    fetchImpl
  });
  if (emailResult.sent) {
    console.log('[email] blueprint sent to ' + emailResult.to + (emailResult.id ? ' (resend id ' + emailResult.id + ')' : ''));
  } else {
    console.warn('[email] blueprint NOT sent to ' + (recipient || 'unknown') + ': ' + emailResult.error);
  }

  // Function D: enrich the contact captured at start (deal + association + note). The contact id
  // signed into the session token is reused so deliver never re-searches by email.
  let hubspotResult = null;
  let contactId = mockLead.contact_id;
  if (hubspot.isEnabled(env)) {
    try {
      hubspotResult = await hubspot.pushLead({
        email, name: leadName, fields: body.fields || null, blueprint: bp, voiceCall: voiceMeta,
        contactId: payload.hubspot_contact_id || null,
        emailResult,
        env, fetchImpl
      });
      if (hubspotResult && hubspotResult.contactId) contactId = hubspotResult.contactId;
      if (hubspotResult && hubspotResult.error) {
        console.warn('[hubspot] push returned error but PDF still delivered:', hubspotResult.error);
      } else {
        console.log('[hubspot] live push ok: contact=' + (hubspotResult && hubspotResult.contactId) + ' deal=' + (hubspotResult && hubspotResult.dealId));
      }
    } catch (e) {
      console.error('[hubspot] live push failed (PDF still delivered):', e.message);
      // Do not block PDF delivery — fall back to the mock id.
    }
  } else {
    logLead(mockLead);
  }

  if (payload.lead_id && leads.isEnabled(env)) {
    try {
      const now = new Date().toISOString();
      await leads.saveBlueprint(payload.lead_id, bp, { generated_at: now, delivered_at: now, pdf_filename: filename }, { env });
      await leads.updateLead(payload.lead_id, {
        email, status: 'blueprint_delivered', blueprint_delivered_at: now,
        consent_given: true, consent_given_at: now
      }, { env });
      await leads.addEvent(payload.lead_id, 'blueprint_delivered', {
        filename, email: pdfEmail.publicEmail(emailResult),
        hubspot: hubspotResult ? { contactId, dealId: hubspotResult.dealId } : null
      }, { env });
    } catch (e) {
      console.error('[deliver] Supabase persistence failed:', e.message);
      return { statusCode: 503, body: { error: 'The PDF was created, but delivery could not be recorded. Please try again.' } };
    }
  }

  return {
    statusCode: 200,
    body: {
      ok: true, contact_id: contactId,
      lead_pushed: !!(hubspotResult && hubspotResult.contactId && !hubspotResult.mocked),
      hubspot: hubspot.publicHubspot(hubspotResult),
      email: pdfEmail.publicEmail(emailResult),
      filename,
      pdf_base64: buffer.toString('base64')
    },
    meta: { mockLead, contactId, hubspotResult, emailResult }
  };
}

module.exports = {
  DELIVER_PER_MIN,
  ratePerMinute,
  checkDeliverRateLimit,
  recipientFromToken,
  deliver
};
