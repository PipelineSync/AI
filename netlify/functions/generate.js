'use strict';
/* Netlify function B: POST /api/generate — dispatcher.
 *
 * Blueprint generation with Claude can exceed the synchronous Netlify limit
 * (Prompt A plus the schema is ~1,500 output tokens, and a schema-validation retry
 * doubles that), so this endpoint never generates in the request. It:
 *   1. re-validates the required review fields server-side (clean 400 with field errors),
 *   2. creates a job id,
 *   3. hands the work to generate-background.js,
 *   4. returns 202 { jobId } immediately.
 * The client polls /api/generate/status?jobId= every 2s for real progress.
 *
 * If the background function cannot be invoked (local dev, tests), the job is run
 * inline before responding — the client path is identical either way.
 */
const core = require('../../lib/core');
const jobs = require('../../lib/job-store');
const job = require('../../lib/generate-job');
const schema = require('../../lib/blueprint-schema');
const { bodyOf, json } = require('../../lib/netlify-helpers');

const BACKGROUND_PATH = '/.netlify/functions/generate-background';

function siteBase(event) {
  const env = process.env;
  const fromEnv = env.DEPLOY_PRIME_URL || env.URL;
  if (fromEnv) return String(fromEnv).replace(/\/$/, '');
  const h = (event.headers || {});
  const host = h['x-forwarded-host'] || h.host;
  if (!host) return null;
  const proto = h['x-forwarded-proto'] || 'https';
  return proto + '://' + host;
}

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') return json(405, { error: 'Method not allowed' });
  let body;
  try { body = bodyOf(event); } catch (e) { return json(413, { error: 'Request body too large.' }); }
  const payload = core.verifyToken(body.token);
  if (!payload) return json(401, { error: 'Your session has ended. Enter your name and email to start again.' });

  const fields = body.fields || {};
  try {
    if (JSON.stringify(fields).length > 100000) return json(400, { error: 'Fields payload too large.' });
  } catch (e) {
    return json(400, { error: 'Invalid fields data.' });
  }

  // Server-side re-validation of the required review fields, before any AI call.
  const v = schema.validateGenerateFields(fields);
  if (!v.ok) {
    return json(400, {
      error: 'Some required answers are missing or invalid. Correct them on the review screen and try again.',
      fieldErrors: v.fieldErrors
    });
  }

  const jobId = jobs.newJobId();
  await job.setStep(jobId, 'validating', { source: null }, { env: process.env });

  const base = siteBase(event);
  let dispatched = false;
  if (base && typeof globalThis.fetch === 'function' && !process.env.GENERATE_INLINE) {
    try {
      const res = await globalThis.fetch(base + BACKGROUND_PATH, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ jobId, token: body.token, fields })
      });
      // Netlify answers a background invocation with 202 and an empty body.
      dispatched = res.status === 202 || res.ok;
    } catch (e) {
      console.warn('[generate] background dispatch failed, running inline:', e.message);
    }
  }

  if (!dispatched) {
    await job.runJob(jobId, fields, payload, { env: process.env });
  }

  return json(202, { ok: true, jobId, status: 'accepted', pollUrl: '/api/generate/status?jobId=' + jobId });
};
