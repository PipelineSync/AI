'use strict';

/* Phase 4: POST /api/lead/booked — the browser calls this after the HubSpot Meetings
 * iframe posts a booking-success message from a HubSpot meetings origin.
 * The signed session fixes the lead; the meeting detail is sanitised in lib/booked-core.js.
 */
const booked = require('../../lib/booked-core');
const { bodyOf, json, checkRateLimit, getClientIp } = require('../../lib/netlify-helpers');

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') return json(405, { error: 'Method not allowed' });
  const ip = getClientIp(event);
  const rl = checkRateLimit('booked:' + ip, 20, 60 * 1000);
  if (!rl.allowed) {
    return {
      statusCode: 429,
      headers: { 'content-type': 'application/json; charset=utf-8', 'retry-after': String(rl.retryAfter || 60), 'cache-control': 'no-store' },
      body: JSON.stringify({ error: 'Too many booking confirmations. Please wait ' + (rl.retryAfter || 60) + 's and try again.' })
    };
  }
  const out = await booked.record({
    body: bodyOf(event), env: process.env, fetchImpl: globalThis.fetch
  });
  return json(out.statusCode, out.body);
};
