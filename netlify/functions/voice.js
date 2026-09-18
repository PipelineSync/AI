'use strict';
/*
 * Netlify function: the voice layer (/api/voice/*).
 * One function serves the four voice routes; netlify.toml rewrites /api/voice/* here.
 * All OpenAI calls happen inside this function, so OPENAI_API_KEY stays server-side.
 */
const { handleVoice, rateLimitFor } = require('../../lib/voice-api');
const helpers = require('../../lib/netlify-helpers');

function bodyOf(event, limitBytes) {
  if (!event.body) return {};
  let raw = event.body;
  if (event.isBase64Encoded) raw = Buffer.from(raw, 'base64').toString('utf8');
  if (limitBytes && raw.length > limitBytes) {
    const err = new Error('Request body too large');
    err.tooLarge = true;
    throw err;
  }
  try { return JSON.parse(raw); } catch (e) { return {}; }
}
/* Security headers come from the shared helpers, so the voice function matches every other one
   (nosniff, frame denial, the CSP that allows the voice audio to play). */
function json(code, obj) {
  return helpers.json(code, obj);
}
/* The redirect /api/voice/* -> /.netlify/functions/voice keeps the original path in the event, but
   depending on how the request was routed that can be event.path, event.rawUrl, or the function path
   itself, so try all of them (and ?op= for direct testing). */
function subRoute(event) {
  const q = (event.queryStringParameters && event.queryStringParameters.op) || '';
  if (q) return q;
  const candidates = [event.path || '', event.rawUrl || '', (event.headers && event.headers['x-original-uri']) || ''];
  for (const c of candidates) {
    // Nested on purpose: /api/voice/realtime/connect, /api/voice/realtime/tool, /api/voice/realtime/end.
    const m = c.match(/\/api\/voice\/([a-z0-9_\/-]+)/);
    if (m) return m[1].replace(/\/+$/, '');
  }
  for (const c of candidates) {
    const m = c.match(/functions\/voice\/?([a-z0-9_\/-]*)/);
    if (m && m[1]) return m[1].replace(/\/+$/, '');
  }
  return '';
}

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') return json(405, { error: 'Method not allowed' });
  let body;
  try {
    body = bodyOf(event, 8 * 1024 * 1024); // audio turns arrive as base64
  } catch (e) {
    return json(e.tooLarge ? 413 : 400, { error: e.tooLarge ? 'That recording is too large. Keep each answer short, or type instead.' : 'Bad request body.' });
  }
  const sub = subRoute(event);
  // Voice turns spend OpenAI credit, so rate limit per IP per minute (in-memory, per warm instance).
  const ip = helpers.getClientIp(event);
  const rl = helpers.checkRateLimit('voice:' + sub + ':' + ip, rateLimitFor(sub), 60 * 1000);
  if (!rl.allowed) {
    const headers = helpers.securityHeaders();
    headers['retry-after'] = String(rl.retryAfter);
    return { statusCode: 429, headers, body: JSON.stringify({ error: 'Too many voice requests. Wait ' + rl.retryAfter + 's and try again.' }) };
  }
  try {
    const out = await handleVoice(sub, body, { env: process.env, fetchImpl: fetch, ip });
    return json(out.status, out.body);
  } catch (e) {
    console.error('[voice] unhandled error:', e && e.message);
    return json(500, { error: 'Voice service error: ' + (e && e.message || 'unknown') });
  }
};
