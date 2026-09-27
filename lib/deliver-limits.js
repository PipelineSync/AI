'use strict';
/*
 * Shared limits for /api/deliver, backed by Netlify Blobs with in-memory Map fallback,
 * same pattern as lib/job-store.js.
 *
 * - Max 3 successful deliveries per email per 24h (DELIVER_PER_EMAIL_DAY, default 3)
 *   Sliding 24h window per email (timestamps).
 * - Global daily cap on emails sent (PDF_EMAIL_DAILY_MAX, default 80)
 *   Calendar day (UTC) bucket.
 *
 * Past the global cap, deliver still returns the PDF with email:{sent:false,error:"daily email limit reached"}.
 * Per-email cap returns 429 before building the PDF.
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

function globalLimit(env) {
  return parseIntEnv(env, 'PDF_EMAIL_DAILY_MAX', 80);
}

function todayUTC() {
  return new Date().toISOString().slice(0, 10); // YYYY-MM-DD
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

/* ---- global daily cap ---- */

async function getGlobalCount(env) {
  const date = todayUTC();
  const key = `global:${date}`;
  const store = getStore(env);
  if (store) {
    try {
      const v = await store.get(key, { type: 'json' });
      if (v && typeof v.count === 'number') return v.count;
      if (typeof v === 'number') return v;
    } catch (e) {
      console.error('[deliver-limits] blob read failed (global), using memory:', e.message);
    }
  }
  const mem = memory.get(key);
  if (mem && typeof mem.count === 'number') return mem.count;
  if (typeof mem === 'number') return mem;
  return 0;
}

async function putGlobalCount(count, env) {
  const date = todayUTC();
  const key = `global:${date}`;
  const record = { count, date, updatedAt: new Date().toISOString() };
  const store = getStore(env);
  if (store) {
    try {
      await store.setJSON(key, record);
      return;
    } catch (e) {
      console.error('[deliver-limits] blob write failed (global), using memory:', e.message);
    }
  }
  memory.set(key, record);
}

async function checkGlobal(env) {
  const limit = globalLimit(env);
  const count = await getGlobalCount(env);
  return { allowed: count < limit, count, limit };
}

async function incrementGlobal(env) {
  const count = await getGlobalCount(env);
  await putGlobalCount(count + 1, env);
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
  globalLimit,
  todayUTC,
  checkPerEmail,
  incrementPerEmail,
  checkGlobal,
  incrementGlobal,
  getPerEmailRecord,
  getGlobalCount,
  _resetMemory,
  _getMemory
};
