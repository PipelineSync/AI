'use strict';
/* Netlify function: /api/auth/start - the entry gate.
 *
 * There is no password and no account to sign in to: the client types their name and
 * email, and we hand back an HMAC-signed stateless session token. The name is what the
 * AI interviewer calls them on the discovery call, and what lands on the HubSpot lead.
 * Production replaces this with Supabase Auth (magic link or OTP) using the same shape.
 *
 * Abuse protections (Phase 5):
 *  - Cloudflare Turnstile, env-gated (TURNSTILE_SITE_KEY + TURNSTILE_SECRET_KEY). When both
 *    are set, the token is verified via POST https://challenges.cloudflare.com/turnstile/v0/siteverify
 *    BEFORE any Supabase or HubSpot write. Failure → 403.
 *  - Demo mode behind DEMO_MODE=true: only then does /api/config return demoMode:true and the UI
 *    show demo controls. When off, demo@pipelinesync.ai is rejected.
 *
 * HubSpot reliability (Phase 7):
 *  - captureLead has a total budget HUBSPOT_START_BUDGET_MS (default 3500). If it runs out,
 *    respond normally with hubspot:{ok:false,pending:true} and no contact id in token.
 *  - Deliver already finds or creates the contact by email later.
 */
const core = require('../../lib/core');
const leads = require('../../lib/supabase-leads');
const hubspot = require('../../lib/hubspot');
const turnstile = require('../../lib/turnstile');
const { bodyOf, json, checkRateLimit, getClientIp } = require('../../lib/netlify-helpers');

function parseBudget(env) {
  const raw = String((env || process.env).HUBSPOT_START_BUDGET_MS || '').trim();
  const n = parseInt(raw, 10);
  return Number.isFinite(n) && n > 0 ? n : 3500;
}

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') return json(405, { error: 'Method not allowed' });
  const ip = getClientIp(event);
  const rl = checkRateLimit('start:' + ip, 20, 60 * 1000);
  if (!rl.allowed) {
    return {
      statusCode: 429,
      headers: { 'content-type': 'application/json; charset=utf-8', 'retry-after': String(rl.retryAfter || 60), 'cache-control': 'no-store' },
      body: JSON.stringify({ error: 'Too many attempts. Please wait ' + (rl.retryAfter || 60) + 's.' })
    };
  }
  const rawBody = bodyOf(event);
  const entry = core.validateEntry(rawBody);
  if (!entry.ok) return json(400, { error: entry.error });

  // Demo mode gate: when DEMO_MODE is off, reject the demo account address.
  if (!turnstile.isDemoModeEnabled(process.env) && String(entry.email).toLowerCase() === 'demo@pipelinesync.ai') {
    return json(403, { error: 'Demo account is not available. Please use your own email.' });
  }

  // Turnstile verification BEFORE any Supabase or HubSpot write, when env-gated.
  if (turnstile.isEnabled(process.env)) {
    const token = String(rawBody.turnstileToken || rawBody['cf-turnstile-response'] || rawBody.turnstile_token || '').trim();
    const verified = await turnstile.verify(token, { env: process.env, fetchImpl: globalThis.fetch, remoteIp: ip });
    if (!verified.ok) {
      return json(403, { error: verified.error || 'Turnstile verification failed. Please try again.' });
    }
  }

  try {
    const lead = await leads.createLead(entry.name, entry.email, { env: process.env });
    if (lead) await leads.addEvent(lead.id, 'lead_signed_up', { source: 'pipelinesync_ai' }, { env: process.env });

    // HubSpot at capture must never fail the entry gate and must respect total budget.
    const budgetMs = parseBudget(process.env);
    let hubspotInfo;
    try {
      const capturePromise = hubspot.captureLead({
        email: entry.email, name: entry.name, env: process.env, fetchImpl: globalThis.fetch
      });
      const timeoutPromise = new Promise((_, reject) => {
        setTimeout(() => {
          const err = new Error('HubSpot start budget exceeded');
          err.code = 'BUDGET_EXCEEDED';
          reject(err);
        }, budgetMs);
      });
      hubspotInfo = await Promise.race([capturePromise, timeoutPromise]);
    } catch (e) {
      if (e && e.code === 'BUDGET_EXCEEDED') {
        console.warn('[entry] HubSpot captureLead budget exceeded after ' + budgetMs + 'ms, returning pending');
        hubspotInfo = { ok: false, mocked: false, pending: true, error: 'HubSpot timeout (budget ' + budgetMs + 'ms)' };
      } else {
        console.warn('[entry] HubSpot captureLead failed within budget:', e.message);
        hubspotInfo = { ok: false, mocked: false, error: e.message };
      }
    }

    const token = core.signToken({
      email: entry.email, name: entry.name,
      lead_id: lead && lead.id ? lead.id : null,
      hubspot_contact_id: hubspotInfo && hubspotInfo.contactId && !hubspotInfo.pending ? hubspotInfo.contactId : null,
      exp: Date.now() + core.TOKEN_TTL_MS
    });
    return json(200, {
      ok: true, token,
      user: {
        name: entry.name, email: entry.email,
        first_name: core.firstNameOf(entry.name), initials: core.initialsOf(entry.name),
        lead_id: lead && lead.id ? lead.id : null
      },
      hubspot: hubspotInfo
    });
  } catch (e) {
    console.error('[entry] could not create lead:', e.message);
    const msg = e.message || '';
    if (/PS_TOKEN_SECRET|required in production/i.test(msg)) {
      return json(500, { error: 'Server configuration error: PS_TOKEN_SECRET is not set.' });
    }
    if (/SUPABASE|WORKSPACE_OWNER_ID/i.test(msg)) {
      return json(500, { error: 'The lead database is not configured correctly.' });
    }
    return json(503, { error: 'We could not save your details right now. Please try again in a moment.' });
  }
};
