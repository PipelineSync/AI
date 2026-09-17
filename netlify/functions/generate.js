'use strict';
/* Netlify function B: /api/generate (mock of Claude + Prompt A + knowledge base v1) */
const core = require('../../lib/core');

function bodyOf(event) {
  if (!event.body) return {};
  let raw = event.body;
  if (event.isBase64Encoded) raw = Buffer.from(raw, 'base64').toString('utf8');
  try { return JSON.parse(raw); } catch (e) { return {}; }
}
function json(code, obj) {
  return { statusCode: code, headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' }, body: JSON.stringify(obj) };
}

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') return json(405, { error: 'Method not allowed' });
  const body = bodyOf(event);
  const payload = core.verifyToken(body.token);
  if (!payload) return json(401, { error: 'Not signed in.' });
  const fields = body.fields || {};
  const blueprint = core.generate(fields);
  return json(200, { ok: true, blueprint });
};
