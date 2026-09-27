'use strict';
/* Shared /api/deliver logic, mounted by netlify/functions/deliver.js and by server.js.
 *
 * Security hardening (Phase 6):
 *  - Server-side blueprint only: takes body.jobId, loads from job-store, rejects 403 if job email != token email, 404 if missing/unfinished. Ignores body.blueprint and body.fields.
 *  - Token email everywhere: uses token's email for HubSpot, Supabase, email send. body.email removed.
 *  - Email verification: env EMAIL_VERIFY default true. PDF download works without verification. Emailing requires 6-digit code via /api/deliver/code.
 *  - Idempotency: key = sha256(token email + jobId), stored in Blobs as {dealId, emailSent, emailId, at, resendUsed, contactId}.
 *  - Supabase failure does not block PDF: returns 200 with persistence:{ok:false}.
 *
 * Abuse limits (Phase 5):
 *  - Per-email daily cap and global daily cap.
 *
 * Both mounts call this one function so deployed and local paths cannot drift.
 */

const crypto = require('crypto');
const core = require('./core');
const leads = require('./supabase-leads');
const hubspot = require('./hubspot');
const pdfEmail = require('./pdf-email');
const { checkRateLimit } = require('./netlify-helpers');
const { clampVoiceMeta } = require('./voice-api');
const deliverLimits = require('./deliver-limits');
const jobs = require('./job-store');
const emailVerify = require('./email-verify');
const idempotency = require('./deliver-idempotency');

const DELIVER_PER_MIN = 5;

function ratePerMinute(env) {
  const n = parseInt(String((env || process.env).DELIVER_RATE_PER_MIN || ''), 10);
  return Number.isFinite(n) && n > 0 ? n : DELIVER_PER_MIN;
}
function checkDeliverRateLimit(ip, env) {
  return checkRateLimit('deliver:' + String(ip || 'unknown'), ratePerMinute(env), 60 * 1000);
}
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

  const tokenEmail = String((payload.email || '')).trim().toLowerCase();
  if (!tokenEmail || !pdfEmail.isEmail(tokenEmail)) {
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

  const isResend = body.resendEmail === true;
  if (idemRec && !isResend) {
    // Repeat call: return PDF again with duplicate:true, no new deal, no email
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
          email: idemRec.emailResult ? pdfEmail.publicEmail(idemRec.emailResult) : { sent: !!idemRec.emailSent, to: tokenEmail },
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

  // Email verification handling
  let emailResult = null;
  let shouldSendEmail = true;
  const verifyEnabled = emailVerify.isVerifyEnabled(env);

  if (verifyEnabled) {
    if (body.code) {
      // Verify code
      try {
        const ver = await emailVerify.verifyCode(tokenEmail, String(body.code), env);
        if (!ver.ok) {
          // Wrong code: don't send email, but still return PDF
          emailResult = { sent: false, to: tokenEmail, error: ver.error || 'invalid code', configured: true, attempted: false };
          shouldSendEmail = false;
          console.warn('[deliver] email verification failed for ' + tokenEmail + ': ' + ver.error);
        } else {
          shouldSendEmail = true;
        }
      } catch (e) {
        console.error('[deliver] verifyCode failed:', e.message);
        emailResult = { sent: false, to: tokenEmail, error: 'verification failed', configured: true, attempted: false };
        shouldSendEmail = false;
      }
    } else {
      // No code provided: check if already verified
      try {
        const already = await emailVerify.isVerified(tokenEmail, env);
        if (!already) {
          shouldSendEmail = false;
          emailResult = { sent: false, to: tokenEmail, error: 'verification required', configured: true, attempted: false };
        }
      } catch (e) {
        shouldSendEmail = false;
        emailResult = { sent: false, to: tokenEmail, error: 'verification required', configured: true, attempted: false };
      }
    }
  }

  // If idempotency exists and this is a resend request, allow one extra email send
  let resendAllowed = false;
  if (idemRec && isResend) {
    if (idemRec.resendUsed) {
      // Already used resend: don't send again
      shouldSendEmail = false;
      if (!emailResult) {
        emailResult = { sent: false, to: tokenEmail, error: 'resend already used', configured: true, attempted: false };
      }
    } else {
      resendAllowed = true;
      // For resend, we need to bypass verification if already verified? Keep verification logic above.
      // If verification required and not verified, still block.
    }
  }

  // Global daily cap and actual email send (if shouldSendEmail)
  if (shouldSendEmail && !emailResult) {
    try {
      const globalCheck = await deliverLimits.checkGlobal(env);
      if (!globalCheck.allowed) {
        emailResult = { sent: false, to: tokenEmail, error: 'daily email limit reached', configured: true, attempted: false };
        console.warn('[email] daily limit reached (' + globalCheck.count + '/' + globalCheck.limit + '), not sending to ' + tokenEmail);
      } else {
        emailResult = await pdfEmail.sendBlueprintEmail({
          to: tokenEmail,
          name: leadName,
          blueprint: bp,
          filename,
          pdfBuffer: buffer,
          env,
          fetchImpl
        });
        if (emailResult.sent) {
          try { await deliverLimits.incrementGlobal(env); } catch (e) { console.error('[deliver] global increment failed:', e.message); }
          console.log('[email] blueprint sent to ' + emailResult.to + (emailResult.id ? ' (resend id ' + emailResult.id + ')' : ''));
        } else {
          console.warn('[email] blueprint NOT sent to ' + tokenEmail + ': ' + emailResult.error);
        }
      }
    } catch (e) {
      console.error('[deliver] global limit check failed, attempting send anyway:', e.message);
      try {
        emailResult = await pdfEmail.sendBlueprintEmail({
          to: tokenEmail,
          name: leadName,
          blueprint: bp,
          filename,
          pdfBuffer: buffer,
          env,
          fetchImpl
        });
        if (emailResult.sent) console.log('[email] blueprint sent to ' + emailResult.to);
        else console.warn('[email] blueprint NOT sent to ' + tokenEmail + ': ' + emailResult.error);
      } catch (err) {
        emailResult = { sent: false, to: tokenEmail, error: err.message, configured: true, attempted: true };
      }
    }
  }

  // If verification required and no code, emailResult already set to verification required
  if (!emailResult) {
    // No email attempted (e.g., verification required or duplicate without resend)
    emailResult = { sent: false, to: tokenEmail, error: 'not attempted', configured: true, attempted: false };
  }

  // Record per-email cap
  try { await deliverLimits.incrementPerEmail(tokenEmail, env); } catch (e) { console.error('[deliver] per-email increment failed:', e.message); }

  // Idempotency: if duplicate without resend, we already returned earlier. Now handle first delivery or resend.
  let hubspotResult = null;
  let contactId = mockLead.contact_id;
  let isDuplicate = !!idemRec;

  if (idemRec && !isResend) {
    // Should have returned earlier, but fallback
    contactId = idemRec.contactId || contactId;
  } else if (idemRec && isResend && resendAllowed) {
    // Resend path: don't create new deal, reuse dealId, but send email if allowed
    contactId = idemRec.contactId || contactId;
    hubspotResult = idemRec.hubspot || null;
    // Update idempotency record to mark resend used
    try {
      await idempotency.put(tokenEmail, jobId, {
        dealId: idemRec.dealId,
        contactId,
        emailSent: emailResult.sent || idemRec.emailSent,
        emailId: emailResult.id || idemRec.emailId,
        emailResult,
        hubspot: hubspotResult,
        at: idemRec.at,
        resendUsed: true,
        resendAt: Date.now()
      }, env);
    } catch (e) { console.error('[deliver] idempotency resend put failed:', e.message); }
  } else {
    // First delivery: HubSpot push
    if (hubspot.isEnabled(env)) {
      try {
        hubspotResult = await hubspot.pushLead({
          email: tokenEmail, name: leadName, fields, blueprint: bp, voiceCall: voiceMeta,
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
      }
    } else {
      logLead(mockLead);
    }

    // Store idempotency record
    try {
      await idempotency.put(tokenEmail, jobId, {
        dealId: hubspotResult && hubspotResult.dealId ? hubspotResult.dealId : null,
        contactId,
        emailSent: !!emailResult.sent,
        emailId: emailResult.id || null,
        emailResult,
        hubspot: hubspotResult,
        at: Date.now(),
        resendUsed: false
      }, env);
    } catch (e) { console.error('[deliver] idempotency put failed:', e.message); }
  }

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
        await leads.addEvent(payload.lead_id, 'blueprint_delivered', {
          filename, email: pdfEmail.publicEmail(emailResult),
          hubspot: hubspotResult ? { contactId, dealId: hubspotResult.dealId } : null
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
      email: pdfEmail.publicEmail(emailResult),
      filename,
      pdf_base64: buffer.toString('base64'),
      persistence
    },
    meta: { mockLead, contactId, hubspotResult, emailResult, persistence, duplicate: isDuplicate }
  };
}

module.exports = {
  DELIVER_PER_MIN,
  ratePerMinute,
  checkDeliverRateLimit,
  recipientFromToken,
  deliver
};
