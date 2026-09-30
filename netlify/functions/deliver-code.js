'use strict';
/*
 * POST /api/deliver/code
 * Sends a 6-digit verification code to the token email.
 * Fixed template, no user text. Stores hash in Blobs with 10-min expiry.
 * Max 3 sends per email per hour, max 5 wrong attempts checked in deliver.
 */

const core = require('../../lib/core');
const jobs = require('../../lib/job-store');
const pdfEmail = require('../../lib/pdf-email');
const emailVerify = require('../../lib/email-verify');
const { bodyOf, json, getClientIp, checkRateLimit } = require('../../lib/netlify-helpers');

function rateLimitKey(ip, email) {
  return 'deliver-code:' + String(ip || 'unknown') + ':' + String(email || '').toLowerCase();
}

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') return json(405, { error: 'Method not allowed' });

  const ip = getClientIp(event);
  // Basic rate limit per IP for code requests
  const rl = checkRateLimit(rateLimitKey(ip, ''), 10, 60 * 1000);
  if (!rl.allowed) {
    return json(429, { error: 'Too many code requests. Please wait ' + (rl.retryAfter || 60) + 's.' }, { 'retry-after': String(rl.retryAfter || 60) });
  }

  let body;
  try { body = bodyOf(event); } catch (e) { return json(413, { error: 'Request body too large.' }); }

  let payload;
  try { payload = core.verifyToken(body.token); } catch (e) {
    return json(500, { error: 'Server misconfigured: missing token secret.' });
  }
  if (!payload) return json(401, { error: 'Your session has ended. Enter your name and email to start again.' });

  const email = String((payload.email || '')).trim().toLowerCase();
  if (!email || !pdfEmail.isEmail(email)) {
    return json(400, { error: 'Invalid session email.' });
  }

  // Optional jobId validation: if provided, ensure job exists and belongs to this email
  if (body.jobId) {
    const rec = await jobs.get(String(body.jobId), { env: process.env });
    if (!rec) return json(404, { error: 'That blueprint job is unknown or has expired. Generate again.' });
    if (rec.email && String(rec.email).toLowerCase() !== email) {
      return json(403, { error: 'This blueprint belongs to a different email.' });
    }
    if (rec.status !== 'done' || !rec.blueprint) {
      return json(404, { error: 'That blueprint job is not ready yet.' });
    }
  }

  // Check if verification is disabled
  if (!emailVerify.isVerifyEnabled(process.env)) {
    return json(200, { ok: true, sent: false, reason: 'verification disabled' });
  }

  // Check per-email hourly limit
  try {
    const can = await emailVerify.canSendCode(email, process.env);
    if (!can.allowed) {
      return json(429, { error: can.reason || 'Too many code requests. Please try again later.' });
    }
  } catch (e) {
    console.error('[deliver-code] canSend check failed:', e.message);
  }

  // Generate and store code
  let code, record;
  try {
    const created = await emailVerify.createCode(email, process.env);
    code = created.code;
    record = created.record;
  } catch (e) {
    if (e.code === 'rate_limited') {
      return json(429, { error: e.message });
    }
    console.error('[deliver-code] createCode failed:', e.message);
    return json(500, { error: 'Could not create verification code.' });
  }

  // Send code via Resend with fixed template (no user text)
  const fetchImpl = globalThis.fetch;
  const from = process.env.PDF_EMAIL_FROM || process.env.EMAIL_FROM || 'Nova PipelineSync AI <no-reply@pipelinesync.ai>';
  const subject = 'Your verification code';
  const text = `Your Nova PipelineSync AI verification code is ${code}. It expires in 10 minutes.\n\nIf you did not request this, you can ignore this email.`;
  const html = `<div style="font-family:system-ui,sans-serif;max-width:480px;margin:0 auto;padding:24px;background:#fff;color:#111"><h2 style="margin:0 0 12px">Your verification code</h2><p style="font-size:24px;font-weight:700;letter-spacing:4px;margin:16px 0">${code}</p><p style="color:#666">It expires in 10 minutes. If you did not request this, you can ignore this email.</p></div>`;

  let emailResult = { sent: false, error: 'not configured' };
  try {
    const apiKey = process.env.PDF_EMAIL_API_KEY || process.env.RESEND_API_KEY;
    if (!apiKey) {
      emailResult = { sent: false, error: 'Email delivery is not configured on this server (PDF_EMAIL_API_KEY is not set)', configured: false };
      console.warn('[deliver-code] no API key, code is ' + code + ' for ' + email + ' (dev mode)');
      // In dev/test without Resend, we still return ok but log code, so tests can proceed
      // For security, don't return code in response unless in test mode with EMAIL_VERIFY off? We return code only when env allows?
      // To make tests deterministic, if PDF_EMAIL_API_KEY missing, we return code in a test-only field when NODE_ENV != production
      const isProd = process.env.CONTEXT === 'production' || process.env.NETLIFY === 'true' || process.env.NODE_ENV === 'production';
      if (!isProd) {
        return json(200, { ok: true, sent: false, devCode: code, error: emailResult.error });
      }
      return json(200, { ok: true, sent: false, error: emailResult.error });
    }
    const res = await fetchImpl('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        'Authorization': 'Bearer ' + apiKey,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        from,
        to: [email],
        subject,
        text,
        html
      })
    });
    const txt = await res.text().catch(() => '');
    let data = {};
    try { data = JSON.parse(txt); } catch (e) {}
    if (res.ok) {
      emailResult = { sent: true, to: email, id: data.id || null };
      console.log('[deliver-code] code sent to ' + email + (data.id ? ' id ' + data.id : ''));
      return json(200, { ok: true, sent: true, to: email });
    } else {
      emailResult = { sent: false, error: data.message || txt || 'Resend error ' + res.status };
      console.warn('[deliver-code] NOT sent to ' + email + ': ' + emailResult.error);
      return json(200, { ok: true, sent: false, error: emailResult.error });
    }
  } catch (e) {
    console.error('[deliver-code] send failed:', e.message);
    return json(200, { ok: true, sent: false, error: e.message });
  }
};
