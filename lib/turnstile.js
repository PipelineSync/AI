'use strict';
/*
 * Cloudflare Turnstile verification, env-gated.
 *
 * Env:
 *   TURNSTILE_SITE_KEY   public, returned by /api/config
 *   TURNSTILE_SECRET_KEY server-only, used for siteverify
 *
 * When both are set, the entry gate must verify the token before any Supabase or HubSpot write.
 * Verification: POST https://challenges.cloudflare.com/turnstile/v0/siteverify
 *   with form fields: secret, response, remoteip
 *
 * This module is shared by server.js and netlify/functions/start.js so the two mounts cannot drift.
 */

const DEFAULT_VERIFY_URL = 'https://challenges.cloudflare.com/turnstile/v0/siteverify';
function getVerifyUrl(env) {
  env = env || process.env;
  const override = String(env.TURNSTILE_VERIFY_URL || '').trim();
  return override || DEFAULT_VERIFY_URL;
}
const VERIFY_URL = DEFAULT_VERIFY_URL;

function str(v) { return String(v == null ? '' : v).trim(); }

function getSiteKey(env) {
  env = env || process.env;
  const k = str(env.TURNSTILE_SITE_KEY);
  return k || null;
}

function getSecret(env) {
  env = env || process.env;
  const k = str(env.TURNSTILE_SECRET_KEY);
  return k || null;
}

function isEnabled(env) {
  env = env || process.env;
  return !!getSiteKey(env) && !!getSecret(env);
}

function isDemoModeEnabled(env) {
  env = env || process.env;
  const raw = str(env.DEMO_MODE).toLowerCase();
  return raw === 'true' || raw === '1' || raw === 'yes';
}

/**
 * Verify a Turnstile token.
 * @param {string} token - the response token from the widget
 * @param {Object} opts - { env, fetchImpl, remoteIp }
 * @returns {Promise<{ok:boolean, error?:string, codes?:string[]}>}
 */
async function verify(token, opts) {
  opts = opts || {};
  const env = opts.env || process.env;
  const secret = getSecret(env);
  // If not enabled, verification is a no-op (behaviour unchanged)
  if (!secret || !getSiteKey(env)) return { ok: true, enabled: false };

  const t = str(token);
  if (!t) {
    return { ok: false, error: 'Turnstile verification required. Please complete the challenge.' };
  }

  const fetchImpl = opts.fetchImpl || (typeof globalThis.fetch === 'function' ? globalThis.fetch : null);
  if (!fetchImpl) {
    return { ok: false, error: 'Server cannot verify Turnstile token (fetch unavailable).' };
  }

  const body = new URLSearchParams();
  body.append('secret', secret);
  body.append('response', t);
  if (opts.remoteIp) body.append('remoteip', String(opts.remoteIp));

  try {
    const url = getVerifyUrl(env);
    const res = await fetchImpl(url, {
      method: 'POST',
      body,
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' }
    });
    const data = await res.json().catch(() => ({}));
    if (data && data.success) {
      return { ok: true };
    }
    const codes = Array.isArray(data['error-codes']) ? data['error-codes'] : [];
    // Map common error codes to a clear message, but keep it generic enough for the UI.
    return {
      ok: false,
      error: 'Turnstile verification failed. Please try again.',
      codes
    };
  } catch (e) {
    return { ok: false, error: 'Could not verify Turnstile token. Please try again.' };
  }
}

module.exports = {
  VERIFY_URL,
  DEFAULT_VERIFY_URL,
  getVerifyUrl,
  getSiteKey,
  getSecret,
  isEnabled,
  isDemoModeEnabled,
  verify
};
