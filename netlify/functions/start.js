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
 */
const core = require('../../lib/core');
const leads = require('../../lib/supabase-leads');
const hubspot = require('../../lib/hubspot');
const turnstile = require('../../lib/turnstile');
const { bodyOf, json, checkRateLimit, getClientIp } = require('../../lib/netlify-helpers');

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
    // Save first so a successful response always represents a captured lead.
    // With no Supabase variables (local tests/demos), createLead intentionally returns null.
    const lead = await leads.createLead(entry.name, entry.email, { env: process.env });
    if (lead) await leads.addEvent(lead.id, 'lead_signed_up', { source: 'pipelinesync_ai' }, { env: process.env });
    // HubSpot at capture must never fail the entry gate. Search-or-create the contact and
    // report the outcome; a missing token is mocked, a live error is returned as hubspot.ok=false.
    const hubspotInfo = await hubspot.captureLead({
      email: entry.email, name: entry.name, env: process.env, fetchImpl: globalThis.fetch
    });
    const token = core.signToken({
      email: entry.email, name: entry.name,
      lead_id: lead && lead.id ? lead.id : null,
      hubspot_contact_id: hubspotInfo && hubspotInfo.contactId ? hubspotInfo.contactId : null,
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
    const configurationError = /PS_TOKEN_SECRET|required in production|needs SUPABASE|WORKSPACE_OWNER_ID/i.test(e.message || '');
    return json(configurationError ? 500 : 503, {
      error: configurationError
        ? 'The lead database is not configured correctly.'
        : 'We could not save your details right now. Please try again in a moment.'
    });
  }
};
