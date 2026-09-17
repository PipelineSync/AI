'use strict';
/* Netlify function A: /api/extract (mock of Claude + Prompt B) */
const core = require('../../lib/core');
const { bodyOf, json, validateAnswers } = require('../../lib/netlify-helpers');

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') return json(405, { error: 'Method not allowed' });
  const body = bodyOf(event);
  const payload = core.verifyToken(body.token);
  if (!payload) return json(401, { error: 'Your session has ended. Enter your name and email to start again.' });
  const v = validateAnswers(body.answers || []);
  if (!v.ok) return json(400, { error: v.error });
  const fields = core.extract(body.answers || []);
  const all = Object.keys(fields);
  const filled = all.filter(k => JSON.stringify(fields[k]) !== 'null' && JSON.stringify(fields[k]) !== '[]' && JSON.stringify(fields[k]) !== '""');
  return json(200, { ok: true, fields, filledCount: filled.length, totalCount: all.length });
};
