'use strict';
/*
 * Shared limits for /api/deliver, backed by Netlify Blobs with in-memory Map fallback,
 * same pattern as lib/job-store.js.
 *
 * - Max 3 successful deliveries per email per 24h (DELIVER_PER_EMAIL_DAY, default 3)
 *   Sliding 24h window per email (timestamps).
 *
 * Past the per-email cap, deliver returns 429 before building the PDF.
 */

const STORE_NAME = 'deliver-limits';
const memory = new Map(); // key -> value (JSON)

let blobsModule;
function loadBlobs() {
  if (blobsModule !== undefined) return blobsModule;
  try {
    blobsModule = require('@netlify/blobs');
  } catch (e) {
    blobsModule = null;
  }
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
  } catch (err) {
    return null;
  }
}

function str(v) { return String(v == null ? '' : v).trim(); }

function parseIntEnv(env, name, def) {
  const raw = str((env || process.env)[name]);
  const n = parseInt(raw, 10);
  return Number.isFinite(n) && n > 0 ? n : def;
}

function perEmailLimit(env) {
  return parseIntEnv(env, 'DELIVER_PER_EMAIL_DAY', 3);
}

function normalizeEmail(email) {
  return String(email || '').trim().toLowerCase();
}

/* ---- per-email sliding window ---- */

async function getPerEmailRecord(email, env) {
  const norm = normalizeEmail(email);
  if (!norm) return { timestamps: [] };
  const key = `email:${norm}`;
  const store = getStore(env);
  if (store) {
    try {
      const v = await store.get(key, { type: 'json' });
      if (v && Array.isArray(v.timestamps)) return v;
    } catch (e) {
      console.error('[deliver-limits] blob read failed (per-email), using memory:', e.message);
    }
  }
  const mem = memory.get(key);
  if (mem && Array.isArray(mem.timestamps)) return mem;
  return { timestamps: [] };
}

async function putPerEmailRecord(email, record, env) {
  const norm = normalizeEmail(email);
  if (!norm) return;
  const key = `email:${norm}`;
  const store = getStore(env);
  if (store) {
    try {
      await store.setJSON(key, record);
      return;
    } catch (e) {
      console.error('[deliver-limits] blob write failed (per-email), using memory:', e.message);
    }
  }
  memory.set(key, record);
}

async function checkPerEmail(email, env) {
  const limit = perEmailLimit(env);
  const rec = await getPerEmailRecord(email, env);
  const now = Date.now();
  const windowMs = 24 * 60 * 60 * 1000;
  const recent = (rec.timestamps || []).filter(ts => typeof ts === 'number' && now - ts < windowMs);
  return { allowed: recent.length < limit, count: recent.length, limit, recent, record: rec };
}

async function incrementPerEmail(email, env) {
  const norm = normalizeEmail(email);
  if (!norm) return;
  const now = Date.now();
  const windowMs = 24 * 60 * 60 * 1000;
  const rec = await getPerEmailRecord(norm, env);
  const recent = (rec.timestamps || []).filter(ts => typeof ts === 'number' && now - ts < windowMs);
  recent.push(now);
  await putPerEmailRecord(norm, { timestamps: recent }, env);
}


/* Test helpers */
function _resetMemory() {
  memory.clear();
}

function _getMemory() {
  return memory;
}

module.exports = {
  STORE_NAME,
  perEmailLimit,
  checkPerEmail,
  incrementPerEmail,
  getPerEmailRecord,
  _resetMemory,
  _getMemory
};
