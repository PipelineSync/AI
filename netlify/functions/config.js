'use strict';
/* Netlify function: GET /api/config — public safe config for the frontend.
 * Returns schedulerLink if SCHEDULER_LINK is set. Never exposes HUBSPOT_ACCESS_TOKEN.
 */
const { json } = require('../../lib/netlify-helpers');

exports.handler = async (event) => {
  if (event.httpMethod !== 'GET' && event.httpMethod !== 'POST') return json(405, { error: 'Method not allowed' });
  const link = String(process.env.SCHEDULER_LINK || '').trim();
  return json(200, {
    ok: true,
    schedulerLink: link || null,
    hubspotEnabled: !!String(process.env.HUBSPOT_ACCESS_TOKEN || process.env.HUBSPOT_API_KEY || '').trim()
  });
};
