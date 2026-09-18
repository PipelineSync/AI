'use strict';
/* Netlify function A: /api/extract (deterministic or optional Claude + Prompt B) */
const core = require('../../lib/core');
const blueprintAI = require('../../lib/blueprint-ai');
const { bodyOf, json, validateAnswers } = require('../../lib/netlify-helpers');

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') return json(405, { error: 'Method not allowed' });
  const body = bodyOf(event);
  const payload = core.verifyToken(body.token);
  if (!payload) return json(401, { error: 'Your session has ended. Enter your name and email to start again.' });
  const v = validateAnswers(body.answers || []);
  if (!v.ok) return json(400, { error: v.error });
  let result;
  try {
    result = await blueprintAI.extract(body.answers || [], { env: process.env, fetchImpl: fetch });
  } catch (e) {
    console.error('[blueprint-ai] extraction failed:', e.message);
    return json(502, { error: 'Blueprint extraction service is unavailable.' });
  }
  const fields = result.fields;
  const all = Object.keys(fields);
  const filled = all.filter(k => JSON.stringify(fields[k]) !== 'null' && JSON.stringify(fields[k]) !== '[]' && JSON.stringify(fields[k]) !== '""');
  return json(200, { ok: true, fields, filledCount: filled.length, totalCount: all.length, ai_provider: result.provider, ai_fallback: !!result.fallback, ai_reason: result.reason || null });
};
