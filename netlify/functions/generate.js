'use strict';
/* Netlify function B: /api/generate (mock of Claude + Prompt A + knowledge base v1) */
const core = require('../../lib/core');
const { bodyOf, json } = require('../../lib/netlify-helpers');

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') return json(405, { error: 'Method not allowed' });
  const body = bodyOf(event);
  const payload = core.verifyToken(body.token);
  if (!payload) return json(401, { error: 'Your session has ended. Enter your name and email to start again.' });
  const fields = body.fields || {};
  try { if (JSON.stringify(fields).length > 100000) return json(400, { error: 'Fields payload too large.' }); } catch (e) {}
  const blueprint = core.generate(fields);
  return json(200, { ok: true, blueprint });
};
