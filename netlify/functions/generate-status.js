'use strict';
/* Netlify function: GET /api/generate/status?jobId=...
 *
 * Lightweight poll target for the client (every 2s). Returns the real progress
 * state of the background job and, once finished, the validated blueprint.
 * Never claims success: status is only "done" when a schema-valid blueprint
 * was actually stored.
 */
const core = require('../../lib/core');
const jobs = require('../../lib/job-store');
const { bodyOf, json, checkRateLimit, getClientIp } = require('../../lib/netlify-helpers');

exports.handler = async (event) => {
  if (event.httpMethod !== 'GET' && event.httpMethod !== 'POST') return json(405, { error: 'Method not allowed' });

  const qs = event.queryStringParameters || {};
  let body = {};
  if (event.httpMethod === 'POST') {
    try { body = bodyOf(event); } catch (e) { return json(413, { error: 'Request body too large.' }); }
  }
  const token = body.token || qs.token ||
    String((event.headers && (event.headers.authorization || event.headers.Authorization)) || '').replace(/^Bearer\s+/i, '');
  const payload = core.verifyToken(token);
  if (!payload) return json(401, { error: 'Your session has ended. Enter your name and email to start again.' });

  // Polling every 2s = 30/min/session; allow headroom, but keep a ceiling per IP.
  const rl = checkRateLimit('genstatus:' + getClientIp(event), 120, 60 * 1000);
  if (!rl.allowed) return json(429, { error: 'Too many status checks. Wait ' + rl.retryAfter + 's and try again.' });

  const jobId = String(body.jobId || qs.jobId || '');
  const rec = await jobs.get(jobId, { env: process.env });
  if (!rec) return json(404, { error: 'That blueprint job is unknown or has expired. Generate again.' });

  const out = {
    ok: true,
    jobId: rec.jobId,
    status: rec.status,
    step: rec.step || null,
    label: rec.label || null,
    progress: typeof rec.progress === 'number' ? rec.progress : 0,
    source: rec.source || null
  };
  if (rec.status === 'done') out.blueprint = rec.blueprint;
  if (rec.status === 'error') { out.error = rec.error || 'Generation failed.'; if (rec.fieldErrors) out.fieldErrors = rec.fieldErrors; }
  return json(200, out);
};
