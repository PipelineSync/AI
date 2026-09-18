'use strict';
/* Netlify function B: /api/generate (deterministic or optional Claude + Prompt A + KB v1) */
const core = require('../../lib/core');
const blueprintAI = require('../../lib/blueprint-ai');
const { bodyOf, json } = require('../../lib/netlify-helpers');

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') return json(405, { error: 'Method not allowed' });
  const body = bodyOf(event);
  const payload = core.verifyToken(body.token);
  if (!payload) return json(401, { error: 'Your session has ended. Enter your name and email to start again.' });
  const fields = body.fields || {};
  try { if (JSON.stringify(fields).length > 100000) return json(400, { error: 'Fields payload too large.' }); } catch (e) {}
  let result;
  try {
    result = await blueprintAI.generate(fields, { env: process.env, fetchImpl: fetch });
  } catch (e) {
    console.error('[blueprint-ai] generation failed:', e.message);
    return json(502, { error: 'Blueprint generation service is unavailable.' });
  }
  return json(200, { ok: true, blueprint: result.blueprint, ai_provider: result.provider, ai_fallback: !!result.fallback, ai_reason: result.reason || null });
};
