'use strict';
/* Shared helpers for Netlify functions — reduces duplication and centralizes security checks */

function bodyOf(event) {
  if (!event.body) return {};
  let raw = event.body;
  if (event.isBase64Encoded) raw = Buffer.from(raw, 'base64').toString('utf8');
  // Limit body size after decode (2MB)
  if (raw.length > 2e6) throw new Error('body too large');
  try { return JSON.parse(raw); } catch (e) { return {}; }
}

function securityHeaders() {
  return {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
    'x-frame-options': 'DENY',
    'referrer-policy': 'strict-origin-when-cross-origin',
    'content-security-policy': "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; connect-src 'self'; font-src 'self'; object-src 'none'; base-uri 'self'; frame-ancestors 'none'",
  };
}

function json(code, obj) {
  return { statusCode: code, headers: securityHeaders(), body: JSON.stringify(obj) };
}

// Simple rate limit check for Netlify (per IP, in-memory per lambda instance)
const rateMap = new Map();
function checkRateLimit(key, max = 20, windowMs = 60 * 1000) {
  const now = Date.now();
  const entry = rateMap.get(key);
  if (!entry || now > entry.resetAt) {
    rateMap.set(key, { count: 1, resetAt: now + windowMs });
    return { allowed: true };
  }
  entry.count++;
  if (entry.count > max) {
    return { allowed: false, retryAfter: Math.ceil((entry.resetAt - now) / 1000) };
  }
  return { allowed: true };
}

function getClientIp(event) {
  return (event.headers && (event.headers['x-nf-client-connection-ip'] || event.headers['client-ip'] || event.headers['x-forwarded-for'])) || 'unknown';
}

function validateAnswers(answers) {
  if (!Array.isArray(answers)) return { ok: false, error: 'answers must be array' };
  if (answers.length > 20) return { ok: false, error: 'Too many answers' };
  for (const a of answers) {
    if (!a || typeof a.id !== 'string' || typeof a.text !== 'string') return { ok: false, error: 'Invalid answer format' };
    if (a.id.length > 100) return { ok: false, error: 'Answer id too long' };
    if (a.text.length > 5000) return { ok: false, error: 'Answer too long (max 5000 chars)' };
  }
  return { ok: true };
}

module.exports = { bodyOf, json, securityHeaders, checkRateLimit, getClientIp, validateAnswers };
