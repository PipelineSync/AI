'use strict';
/* Netlify function: /api/auth/start - the entry gate.
 *
 * There is no password and no account to sign in to: the client types their name and
 * email, and we hand back an HMAC-signed stateless session token. The name is what the
 * AI interviewer calls them on the discovery call, and what lands on the HubSpot lead.
 * Production replaces this with Supabase Auth (magic link or OTP) using the same shape.
 */
const core = require('../../lib/core');
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
  const entry = core.validateEntry(bodyOf(event));
  if (!entry.ok) return json(400, { error: entry.error });
  try {
    const token = core.signToken({ email: entry.email, name: entry.name, exp: Date.now() + core.TOKEN_TTL_MS });
    return json(200, {
      ok: true, token,
      user: { name: entry.name, email: entry.email, first_name: core.firstNameOf(entry.name), initials: core.initialsOf(entry.name) }
    });
  } catch (e) {
    console.error('[security] entry gate failed:', e.message);
    return json(500, { error: 'Server misconfigured: missing token secret.' });
  }
};
