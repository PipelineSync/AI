'use strict';
/*
 * Email verification via 6-digit code, env-gated.
 * EMAIL_VERIFY default true. When false, emailing is allowed without code.
 *
 * Flow:
 *  POST /api/deliver/code -> generates 6-digit, hashes, stores in Blobs with 10-min expiry,
 *  max 3 sends per email per hour, max 5 wrong attempts per code.
 *  Then /api/deliver with {jobId, code} verifies and allows email.
 *
 * Storage: Netlify Blobs (email-verify) fallback to in-memory Map, same pattern as job-store.
 *  Keys:
 *    code:{email} -> {hash, expiresAt, attempts, verifiedAt?, sendCount?}
 *    send:{email} -> [timestamps] for hourly limit (separate from code record, but we combine)
 *
 * No user text in code email template.
 */

const crypto = require('crypto');

const STORE_NAME = 'email-verify';
const CODE_TTL_MS = 10 * 60 * 1000; // 10 minutes
const SEND_WINDOW_MS = 60 * 60 * 1000; // 1 hour
const MAX_SENDS_PER_HOUR = 3;
const MAX_WRONG_ATTEMPTS = 5;

const memory = new Map();

let blobsModule;
function loadBlobs() {
  if (blobsModule !== undefined) return blobsModule;
  try { blobsModule = require('@netlify/blobs'); } catch (e) { blobsModule = null; }
  return blobsModule;
}
function getStore(env) {
  const mod = loadBlobs();
  if (!mod || typeof mod.getStore !== 'function') return null;
  const e = env || process.env;
  try {
    if (e.NETLIFY_BLOBS_SITE_ID && e.NETLIFY_BLOBS_TOKEN) {
      return mod.getStore({ name: STORE_NAME, siteID: e.NETLIFY_BLOBS_SITE_ID, token: e.NETLIFY_BLOBS_TOKEN });
    }
    return mod.getStore(STORE_NAME);
  } catch (err) { return null; }
}
function prune() {
  const now = Date.now();
  for (const [k, v] of memory) {
    if (v && v.expiresAt && v.expiresAt < now) memory.delete(k);
    // Clean send windows
    if (k.startsWith('send:') && Array.isArray(v)) {
      const filtered = v.filter(t => now - t < SEND_WINDOW_MS);
      if (filtered.length === 0) memory.delete(k);
      else memory.set(k, filtered);
    }
  }
}

function isVerifyEnabled(env) {
  env = env || process.env;
  const raw = String(env.EMAIL_VERIFY == null ? '' : env.EMAIL_VERIFY).trim().toLowerCase();
  if (raw === '' ) return true; // default true
  if (raw === 'false' || raw === '0' || raw === 'no' || raw === 'off') return false;
  if (raw === 'true' || raw === '1' || raw === 'yes' || raw === 'on') return true;
  return true;
}

function normalizeEmail(email) {
  return String(email || '').trim().toLowerCase();
}
function hashCode(code) {
  return crypto.createHash('sha256').update(String(code)).digest('hex');
}
function generateCode() {
  // 6-digit, not starting with 0
  const n = crypto.randomInt(100000, 1000000);
  return String(n);
}

async function getRecord(email, env) {
  const norm = normalizeEmail(email);
  if (!norm) return null;
  const key = 'code:' + norm;
  const store = getStore(env);
  if (store) {
    try {
      const v = await store.get(key, { type: 'json' });
      if (v) return v;
    } catch (e) {}
  }
  prune();
  return memory.get(key) || null;
}
async function putRecord(email, record, env) {
  const norm = normalizeEmail(email);
  if (!norm) return null;
  const key = 'code:' + norm;
  const store = getStore(env);
  if (store) {
    try {
      await store.setJSON(key, record);
    } catch (e) {
      console.error('[email-verify] blob write failed, using memory:', e.message);
    }
  }
  prune();
  memory.set(key, record);
  return record;
}
async function getSendTimestamps(email, env) {
  const norm = normalizeEmail(email);
  if (!norm) return [];
  const key = 'send:' + norm;
  const store = getStore(env);
  if (store) {
    try {
      const v = await store.get(key, { type: 'json' });
      if (Array.isArray(v)) {
        const now = Date.now();
        return v.filter(t => now - t < SEND_WINDOW_MS);
      }
    } catch (e) {}
  }
  prune();
  const v = memory.get(key);
  if (Array.isArray(v)) {
    const now = Date.now();
    return v.filter(t => now - t < SEND_WINDOW_MS);
  }
  return [];
}
async function addSendTimestamp(email, env) {
  const norm = normalizeEmail(email);
  if (!norm) return;
  const key = 'send:' + norm;
  const now = Date.now();
  let arr = await getSendTimestamps(norm, env);
  arr.push(now);
  const store = getStore(env);
  if (store) {
    try { await store.setJSON(key, arr); } catch (e) {}
  }
  memory.set(key, arr);
}

async function canSendCode(email, env) {
  const norm = normalizeEmail(email);
  if (!norm) return { allowed: false, reason: 'invalid email' };
  const sends = await getSendTimestamps(norm, env);
  if (sends.length >= MAX_SENDS_PER_HOUR) {
    return { allowed: false, reason: 'too many code requests, try again later', count: sends.length, limit: MAX_SENDS_PER_HOUR };
  }
  return { allowed: true, count: sends.length, limit: MAX_SENDS_PER_HOUR };
}

async function createCode(email, env) {
  const norm = normalizeEmail(email);
  if (!norm) throw new Error('invalid email');
  const can = await canSendCode(norm, env);
  if (!can.allowed) {
    const err = new Error(can.reason);
    err.code = 'rate_limited';
    err.count = can.count;
    throw err;
  }
  const code = generateCode();
  const hash = hashCode(code);
  const record = {
    hash,
    expiresAt: Date.now() + CODE_TTL_MS,
    attempts: 0,
    createdAt: Date.now(),
    email: norm
  };
  await putRecord(norm, record, env);
  await addSendTimestamp(norm, env);
  return { code, record };
}

async function verifyCode(email, code, env) {
  const norm = normalizeEmail(email);
  if (!norm) return { ok: false, error: 'invalid email' };
  const rec = await getRecord(norm, env);
  if (!rec) return { ok: false, error: 'no code requested' };
  if (rec.expiresAt && rec.expiresAt < Date.now()) {
    return { ok: false, error: 'code expired' };
  }
  if (rec.attempts >= MAX_WRONG_ATTEMPTS) {
    return { ok: false, error: 'too many wrong attempts' };
  }
  const h = hashCode(code);
  if (h === rec.hash) {
    // Success: mark verified, keep record for a bit but reset attempts
    rec.verifiedAt = Date.now();
    rec.attempts = 0;
    await putRecord(norm, rec, env);
    return { ok: true };
  } else {
    rec.attempts = (rec.attempts || 0) + 1;
    await putRecord(norm, rec, env);
    if (rec.attempts >= MAX_WRONG_ATTEMPTS) {
      return { ok: false, error: 'too many wrong attempts' };
    }
    return { ok: false, error: 'invalid code', attemptsLeft: MAX_WRONG_ATTEMPTS - rec.attempts };
  }
}

async function isVerified(email, env) {
  const rec = await getRecord(email, env);
  if (!rec) return false;
  if (rec.expiresAt && rec.expiresAt < Date.now()) return false;
  return !!rec.verifiedAt;
}

function _resetMemory() {
  memory.clear();
}

module.exports = {
  STORE_NAME,
  CODE_TTL_MS,
  SEND_WINDOW_MS,
  MAX_SENDS_PER_HOUR,
  MAX_WRONG_ATTEMPTS,
  isVerifyEnabled,
  normalizeEmail,
  hashCode,
  generateCode,
  canSendCode,
  createCode,
  verifyCode,
  isVerified,
  getRecord,
  _resetMemory
};
