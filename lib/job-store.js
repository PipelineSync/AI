'use strict';
/*
 * Job store for the background blueprint generation.
 *
 * Netlify background functions cannot answer the original request, so the result
 * is parked here and the client polls /api/generate/status?jobId=.
 *
 * Storage: Netlify Blobs (@netlify/blobs — the one allowed runtime dependency in
 * server code, per Phase 2). When it is not available (local `node server.js`,
 * the test suite), it degrades to an in-process Map so the same code path is
 * exercised end to end.
 */

const crypto = require('crypto');

const STORE_NAME = 'blueprint-jobs';
const JOB_TTL_MS = 60 * 60 * 1000; // an hour is plenty for a poll loop

const memory = new Map();

function newJobId() {
  return crypto.randomBytes(16).toString('hex');
}

let blobsModule; // undefined = not tried yet, null = unavailable
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
    // On Netlify the deploy context is injected automatically; siteID/token are the
    // explicit escape hatch when running outside that context.
    if (e.NETLIFY_BLOBS_SITE_ID && e.NETLIFY_BLOBS_TOKEN) {
      return mod.getStore({ name: STORE_NAME, siteID: e.NETLIFY_BLOBS_SITE_ID, token: e.NETLIFY_BLOBS_TOKEN });
    }
    return mod.getStore(STORE_NAME);
  } catch (err) {
    return null;
  }
}

function prune() {
  const now = Date.now();
  for (const [k, v] of memory) if (v && v.expiresAt && v.expiresAt < now) memory.delete(k);
}

/**
 * Write (or overwrite) a job record.
 * @param {string} jobId
 * @param {Object} record - { status: 'pending'|'running'|'done'|'error', ... }
 */
async function put(jobId, record, opts) {
  opts = opts || {};
  const value = Object.assign({}, record, {
    jobId,
    updatedAt: new Date().toISOString(),
    expiresAt: Date.now() + JOB_TTL_MS
  });
  const store = getStore(opts.env);
  if (store) {
    try {
      await store.setJSON(jobId, value);
      return value;
    } catch (e) {
      console.error('[job-store] blob write failed, using memory:', e.message);
    }
  }
  prune();
  memory.set(jobId, value);
  return value;
}

/**
 * Read a job record. Returns null when unknown or expired.
 */
async function get(jobId, opts) {
  opts = opts || {};
  if (!jobId || typeof jobId !== 'string' || !/^[a-f0-9]{8,64}$/i.test(jobId)) return null;
  const store = getStore(opts.env);
  if (store) {
    try {
      const v = await store.get(jobId, { type: 'json' });
      if (v) return v;
    } catch (e) {
      console.error('[job-store] blob read failed, using memory:', e.message);
    }
  }
  prune();
  return memory.get(jobId) || null;
}

/** Test/dev helper: is the durable Netlify Blobs backend in use? */
function isDurable(env) {
  return !!getStore(env);
}

/** Test helper: drop every in-memory record. */
function _resetMemory() {
  memory.clear();
}

module.exports = { newJobId, put, get, isDurable, STORE_NAME, JOB_TTL_MS, _resetMemory };
