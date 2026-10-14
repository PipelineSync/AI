'use strict';
/* Netlify function: /api/deliver
 *
 * C: builds the PDF server-side (pure-JS writer) and returns it as base64.
 *    The browser downloads it; nothing is emailed.
 * D: pushes the lead to HubSpot. When HUBSPOT_ACCESS_TOKEN is set (Private App token
 *    pat-na1-...), the lead is pushed live to HubSpot Contacts + Deals + a note via
 *    lib/hubspot.js. Without the token the
 *    payload is logged to the Netlify function logs as [hubspot-mock] (so demos never break).
 *
 * The work itself lives in lib/deliver-core.js, which the local dev server mounts too, so the
 * deployed and local paths cannot drift apart.
 */
const deliverCore = require('../../lib/deliver-core');
const { bodyOf, json, getClientIp } = require('../../lib/netlify-helpers');

exports.handler = async (event) => {
  require('../../lib/netlify-helpers').connectBlobs(event);
  if (event.httpMethod !== 'POST') return json(405, { error: 'Method not allowed' });

  // Phase 3: 5 unlocks per minute per IP. Each attempt builds a PDF and may send an email.
  const ip = getClientIp(event);
  const rl = deliverCore.checkDeliverRateLimit(ip, process.env);
  if (!rl.allowed) {
    return {
      statusCode: 429,
      headers: {
        'content-type': 'application/json; charset=utf-8',
        'cache-control': 'no-store',
        'retry-after': String(rl.retryAfter || 60)
      },
      body: JSON.stringify({ error: 'Too many unlock attempts. Please wait ' + (rl.retryAfter || 60) + 's and try again.' })
    };
  }

  const out = await deliverCore.deliver({
    body: bodyOf(event),
    env: process.env,
    fetchImpl: globalThis.fetch
  });
  return json(out.statusCode, out.body);
};
