'use strict';
/*
 * Idempotency for /api/deliver: key = sha256(token email + jobId)
 * Stored in Blobs as {dealId, emailSent, emailId, at, resendUsed}
 * Fallback to in-memory Map like job-store.
 */

const crypto = require('crypto');

const STORE_NAME = 'deliver-idempotency';
const TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

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
  }
}
function makeKey(email, jobId) {
  const normEmail = String(email || '').trim().toLowerCase();
  const normJob = String(jobId || '').trim();
  const raw = normEmail + ':' + normJob;
  return crypto.createHash('sha256').update(raw).digest('hex');
}

async function get(email, jobId, env) {
  const key = makeKey(email, jobId);
  if (!key) return null;
  const store = getStore(env);
  if (store) {
    try {
      const v = await store.get(key, { type: 'json' });
      if (v) return v;
    } catch (e) {
      console.error('[idempotency] blob read failed, using memory:', e.message);
    }
  }
  prune();
  return memory.get(key) || null;
}

async function put(email, jobId, record, env) {
  const key = makeKey(email, jobId);
  const value = Object.assign({}, record, {
    key,
    email: String(email || '').trim().toLowerCase(),
    jobId: String(jobId || '').trim(),
    at: record.at || Date.now(),
    expiresAt: Date.now() + TTL_MS
  });
  const store = getStore(env);
  if (store) {
    try {
      await store.setJSON(key, value);
    } catch (e) {
      console.error('[idempotency] blob write failed, using memory:', e.message);
    }
  }
  prune();
  memory.set(key, value);
  return value;
}

function _resetMemory() { memory.clear(); }

module.exports = { makeKey, get, put, _resetMemory, STORE_NAME, TTL_MS };
