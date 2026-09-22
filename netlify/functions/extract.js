'use strict';
/* Netlify function A: /api/extract
 * Claude (PROMPT_B) when ANTHROPIC_API_KEY is set, deterministic core.extract() otherwise.
 * Claude output is schema-validated server-side; invalid output retries once and then
 * falls back. The response always states which path was used: source "claude" | "fallback".
 */
const ai = require('../../lib/ai-pipeline');
const core = require('../../lib/core');
const { bodyOf, json, validateAnswers } = require('../../lib/netlify-helpers');

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') return json(405, { error: 'Method not allowed' });
  let body;
  try { body = bodyOf(event); } catch (e) { return json(413, { error: 'Request body too large.' }); }
  const payload = core.verifyToken(body.token);
  if (!payload) return json(401, { error: 'Your session has ended. Enter your name and email to start again.' });
  const v = validateAnswers(body.answers || []);
  if (!v.ok) return json(400, { error: v.error });

  const result = await ai.runExtract(body.answers || [], { env: process.env });
  if (result.source === 'fallback' && result.reason && result.reason !== 'no-api-key' && result.reason !== 'no-answers') {
    console.warn('[extract] Claude output unusable (' + result.reason + '):', JSON.stringify(result.validationErrors || result.aiError));
  }
  return json(200, {
    ok: true,
    fields: result.fields,
    filledCount: result.filledCount,
    totalCount: result.totalCount,
    source: result.source
  });
};
