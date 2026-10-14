'use strict';
/* Shared /api/deliver logic, mounted by netlify/functions/deliver.js and by server.js.
 *
 * Security hardening (Phase 6):
 *  - Server-side blueprint only: takes body.jobId, loads from job-store, rejects 403 if job email != token email, 404 if missing/unfinished. Ignores body.blueprint and body.fields.
 *  - Token email everywhere: uses the token's email for HubSpot and Supabase. body.email removed.
 *  - The PDF is returned to the browser to download. Nothing is emailed.
 *  - Idempotency: key = sha256(token email + jobId), stored in Blobs as {dealId, at, contactId, hubspot}.
 *  - Supabase failure does not block PDF: returns 200 with persistence:{ok:false}.
 *
 * Abuse limits (Phase 5):
 *  - Per-email daily cap.
 *
 * Both mounts call this one function so deployed and local paths cannot drift.
 */

const crypto = require('crypto');
const core = require('./core');
const autopilot = require('./autopilot');
const leads = require('./supabase-leads');
const hubspot = require('./hubspot');
const { checkRateLimit } = require('./netlify-helpers');
const { clampVoiceMeta } = require('./voice-api');
const deliverLimits = require('./deliver-limits');
const jobs = require('./job-store');
const consent = require('./consent');
const idempotency = require('./deliver-idempotency');

const DELIVER_PER_MIN = 5;

function ratePerMinute(env) {
  const n = parseInt(String((env || process.env).DELIVER_RATE_PER_MIN || ''), 10);
  return Number.isFinite(n) && n > 0 ? n : DELIVER_PER_MIN;
}
function checkDeliverRateLimit(ip, env) {
  return checkRateLimit('deliver:' + String(ip || 'unknown'), ratePerMinute(env), 60 * 1000);
}
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
function isEmail(v) {
  const s = String(v == null ? '' : v).trim().toLowerCase();
  return s.length > 0 && s.length <= 254 && EMAIL_RE.test(s);
}
function recipientFromToken(payload) {
  const email = String((payload && payload.email) || '').trim().toLowerCase();
  return isEmail(email) ? email : null;
}
function logLead(lead) {
  console.log('[hubspot-mock] lead push: ' + JSON.stringify(lead));
}
/* The moment the visitor actually agreed, when the browser sends it (zero-touch carries the
   consent screen's timestamp through, so the CRM note records the agreement rather than the
   delivery). Anything unparseable or implausibly far in the past falls back to now. */
function consentMoment(raw) {
  const now = new Date().toISOString();
  const s = String(raw || '').trim();
  if (!s) return now;
  const t = Date.parse(s);
  if (!Number.isFinite(t)) return now;
  const age = Date.now() - t;
  if (age < 0 || age > 24 * 60 * 60 * 1000) return now;
  return new Date(t).toISOString();
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

  const tokenEmail = String((payload.email || '')).trim().toLowerCase();
  if (!tokenEmail || !isEmail(tokenEmail)) {
    return { statusCode: 400, body: { error: 'Invalid session email.' } };
  }

  // Consent still required, but email comes from token
  if (body.consent !== true) {
    return { statusCode: 400, body: { error: 'Please tick the consent box before we send the PDF.' } };
  }

  const jobId = String(body.jobId || '').trim();
  if (!jobId) {
    return { statusCode: 400, body: { error: 'Missing blueprint job. Generate the blueprint before unlocking the PDF.' } };
  }

  // Load job from store, ignore body.blueprint entirely
  let jobRec;
  try {
    jobRec = await jobs.get(jobId, { env });
  } catch (e) {
    console.error('[deliver] job get failed:', e.message);
    jobRec = null;
  }
  // The store could not produce the job: fall back to the server-signed copy the browser holds.
  if ((!jobRec || jobRec.status !== 'done' || !jobRec.blueprint) && body.jobSeal) {
    const sealed = core.openJobSeal(body.jobSeal, jobId, tokenEmail);
    if (sealed) {
      jobRec = sealed;
      jobs.put(jobId, sealed, { env }).catch(e => console.warn('[deliver] could not re-store the sealed job:', e.message));
    }
  }
  if (!jobRec || jobRec.status !== 'done' || !jobRec.blueprint || !jobRec.blueprint.meta || !jobRec.blueprint.meta.verticalLabel) {
    return { statusCode: 404, body: { error: 'That blueprint job is unknown or not ready. Generate again.' } };
  }

  // Reject if job's email doesn't match token's email
  if (jobRec.email) {
    const jobEmail = String(jobRec.email).trim().toLowerCase();
    if (jobEmail && jobEmail !== tokenEmail) {
      return { statusCode: 403, body: { error: 'This blueprint belongs to a different email.' } };
    }
  }

  const bp = jobRec.blueprint;
  const fields = jobRec.fields || {};

  // Per-email daily cap
  try {
    const perEmail = await deliverLimits.checkPerEmail(tokenEmail, env);
    if (!perEmail.allowed) {
      return { statusCode: 429, body: { error: 'Too many deliveries for this email today. Please try again tomorrow.' } };
    }
  } catch (e) {
    console.error('[deliver] per-email limit check failed, allowing:', e.message);
  }

  // Idempotency check: key = sha256(token email + jobId)
  let idemRec = null;
  try {
    idemRec = await idempotency.get(tokenEmail, jobId, env);
  } catch (e) {
    console.error('[deliver] idempotency get failed:', e.message);
  }

  if (idemRec) {
    // Repeat call: return the same PDF with duplicate:true, no new deal
    try {
      const buffer = core.buildPdf(bp);
      const filename = core.pdfFilename(bp);
      return {
        statusCode: 200,
        body: {
          ok: true,
          duplicate: true,
          contact_id: idemRec.contactId || idemRec.contact_id || null,
          lead_pushed: false,
          hubspot: idemRec.hubspot || { mocked: true },
          filename,
          pdf_base64: buffer.toString('base64'),
          persistence: { ok: true }
        },
        meta: { duplicate: true, idemRec }
      };
    } catch (e) {
      console.error('[deliver] duplicate pdf build failed:', e.message);
    }
  }

  // Build PDF (always works, even without verification)
  const buffer = core.buildPdf(bp);
  const filename = core.pdfFilename(bp);
  const leadName = core.cleanName(payload.name) || core.loginNameFor(tokenEmail);
  const voiceMeta = clampVoiceMeta(body.voice_meta);
  const mockLead = core.makeLeadPayload(tokenEmail, leadName, fields, bp, voiceMeta);

  /* Zero-touch (AUTO_DELIVER): the browser asks for the PDF as soon as the blueprint is built,
     carrying the consent given on the consent screen with its timestamp, so the CRM note records
     the agreement rather than this request. */
  const autoDelivery = body.auto === true && autopilot.isEnabled(env);
  const consentAt = autoDelivery ? consentMoment(body.consent_at) : new Date().toISOString();

  // Record per-email cap
  try { await deliverLimits.incrementPerEmail(tokenEmail, env); } catch (e) { console.error('[deliver] per-email increment failed:', e.message); }

  // First delivery (a repeat returned the same PDF further up).
  let hubspotResult = null;
  let contactId = mockLead.contact_id;
  const isDuplicate = false;
  // HubSpot push
  if (hubspot.isEnabled(env)) {
    try {
      const consentVersion = consent.CONSENT_VERSION;
      const privacyUrl = consent.getPrivacyPolicyUrl(env);
      hubspotResult = await hubspot.pushLead({
        email: tokenEmail, name: leadName, fields, blueprint: bp, voiceCall: voiceMeta,
        contactId: payload.hubspot_contact_id || null,
        env, fetchImpl,
        consentInfo: {
          consent_at: consentAt,
          consent_version: consentVersion,
          privacy_policy_url: privacyUrl,
          source: autoDelivery ? 'entry gate (zero-touch delivery)' : 'PDF unlock screen'
        }
      });
      if (hubspotResult && hubspotResult.contactId) contactId = hubspotResult.contactId;
      if (hubspotResult && hubspotResult.error) {
        console.warn('[hubspot] push returned error but PDF still delivered:', hubspotResult.error);
      } else {
        console.log('[hubspot] live push ok: contact=' + (hubspotResult && hubspotResult.contactId) + ' deal=' + (hubspotResult && hubspotResult.dealId));
      }
    } catch (e) {
      console.error('[hubspot] live push failed (PDF still delivered):', e.message);
    }
  } else {
    logLead(mockLead);
  }

  // Store idempotency record
  try {
    await idempotency.put(tokenEmail, jobId, {
      dealId: hubspotResult && hubspotResult.dealId ? hubspotResult.dealId : null,
      contactId,
      hubspot: hubspotResult,
      at: Date.now()
    }, env);
  } catch (e) { console.error('[deliver] idempotency put failed:', e.message); }

  // Supabase persistence: must not block PDF
  let persistence = { ok: true };
  if (payload.lead_id && leads.isEnabled(env)) {
    try {
      const now = new Date().toISOString();
      await leads.saveBlueprint(payload.lead_id, bp, { generated_at: now, delivered_at: now, pdf_filename: filename }, { env });
      await leads.updateLead(payload.lead_id, {
        email: tokenEmail, status: 'blueprint_delivered', blueprint_delivered_at: now,
        consent_given: true, consent_given_at: now
      }, { env });
      // Only first delivery writes blueprint_delivered event
      if (!isDuplicate) {
        const consentAt2 = new Date().toISOString();
        await leads.addEvent(payload.lead_id, 'blueprint_delivered', {
          filename,
          hubspot: hubspotResult ? { contactId, dealId: hubspotResult.dealId } : null,
          consent_at: consentAt2,
          consent_version: consent.CONSENT_VERSION,
          privacy_policy_url: consent.getPrivacyPolicyUrl(env) || null
        }, { env });
      }
    } catch (e) {
      console.error('[deliver] Supabase persistence failed:', e.message);
      persistence = { ok: false, error: e.message };
    }
  }

  return {
    statusCode: 200,
    body: {
      ok: true,
      duplicate: isDuplicate,
      contact_id: contactId,
      lead_pushed: !!(hubspotResult && hubspotResult.contactId && !hubspotResult.mocked),
      hubspot: hubspot.publicHubspot(hubspotResult),
      filename,
      pdf_base64: buffer.toString('base64'),
      persistence
    },
    meta: { mockLead, contactId, hubspotResult, persistence, duplicate: isDuplicate }
  };
}

module.exports = {
  DELIVER_PER_MIN,
  ratePerMinute,
  checkDeliverRateLimit,
  recipientFromToken,
  deliver
};
