'use strict';
/* Netlify BACKGROUND function: /.netlify/functions/generate-background
 *
 * Netlify runs any function whose filename ends in "-background" asynchronously
 * (15 minute ceiling) and replies 202 immediately to the caller. The result is
 * written to the job store (Netlify Blobs) and read back by
 * /api/generate/status?jobId=.
 *
 * It is invoked by netlify/functions/generate.js — never by the browser.
 */
const core = require('../../lib/core');
const job = require('../../lib/generate-job');
const jobs = require('../../lib/job-store');
const schema = require('../../lib/blueprint-schema');
const { bodyOf, json } = require('../../lib/netlify-helpers');

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') return json(405, { error: 'Method not allowed' });
  let body;
  try { body = bodyOf(event); } catch (e) { return json(413, { error: 'Request body too large.' }); }

  const payload = core.verifyToken(body.token);
  if (!payload) return json(401, { error: 'Your session has ended. Enter your name and email to start again.' });

  const jobId = String(body.jobId || '');
  if (!/^[a-f0-9]{8,64}$/i.test(jobId)) return json(400, { error: 'Invalid jobId.' });

  const fields = body.fields || {};
  const v = schema.validateGenerateFields(fields);
  if (!v.ok) {
    await jobs.put(jobId, {
      status: 'error', step: 'error', label: job.LABELS.error, progress: 100,
      error: 'Some required answers are missing or invalid.', fieldErrors: v.fieldErrors
    }, { env: process.env });
    return json(400, { error: 'Invalid fields.', fieldErrors: v.fieldErrors });
  }

  await job.runJob(jobId, fields, payload, { env: process.env });
  return json(202, { ok: true, jobId });
};
