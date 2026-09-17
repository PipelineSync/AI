'use strict';
/* Netlify function: /api/auth/login (Supabase Auth stand-in, stateless) */
const core = require('../../lib/core');

function bodyOf(event) {
  if (!event.body) return {};
  let raw = event.body;
  if (event.isBase64Encoded) raw = Buffer.from(raw, 'base64').toString('utf8');
  try { return JSON.parse(raw); } catch (e) { return {}; }
}
function json(code, obj) {
  return { statusCode: code, headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' }, body: JSON.stringify(obj) };
}

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') return json(405, { error: 'Method not allowed' });
  const body = bodyOf(event);
  const email = String(body.email || '').trim().toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return json(400, { error: 'Enter a valid email address.' });
  if (String(body.password || '').length < 4) return json(400, { error: 'Password must be at least 4 characters (prototype rule).' });
  const name = core.loginNameFor(email);
  const token = core.signToken({ email, name, exp: Date.now() + core.TOKEN_TTL_MS });
  return json(200, { ok: true, token, user: { name, email } });
};
