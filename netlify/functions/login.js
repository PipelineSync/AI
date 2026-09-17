'use strict';
/* Netlify function: /api/auth/login (Supabase Auth stand-in, stateless) */
const core = require('../../lib/core');
const { bodyOf, json, checkRateLimit, getClientIp } = require('../../lib/netlify-helpers');

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') return json(405, { error: 'Method not allowed' });
  const ip = getClientIp(event);
  const rl = checkRateLimit('login:' + ip, 20, 60 * 1000);
  if (!rl.allowed) {
    return {
      statusCode: 429,
      headers: { 'content-type': 'application/json; charset=utf-8', 'retry-after': String(rl.retryAfter || 60), 'cache-control': 'no-store' },
      body: JSON.stringify({ error: 'Too many login attempts. Please wait ' + (rl.retryAfter || 60) + 's.' })
    };
  }
  const body = bodyOf(event);
  const email = String(body.email || '').trim().toLowerCase();
  const password = String(body.password || '');
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return json(400, { error: 'Enter a valid email address.' });
  if (email.length > 254) return json(400, { error: 'Email too long.' });
  if (password.length < 4) return json(400, { error: 'Password must be at least 4 characters (prototype rule).' });
  if (password.length > 128) return json(400, { error: 'Password too long.' });
  try {
    const name = core.loginNameFor(email);
    const token = core.signToken({ email, name, exp: Date.now() + core.TOKEN_TTL_MS });
    return json(200, { ok: true, token, user: { name, email } });
  } catch (e) {
    console.error('[security] login failed:', e.message);
    return json(500, { error: 'Server misconfigured: missing token secret.' });
  }
};
