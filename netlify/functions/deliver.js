'use strict';
/* Netlify functions C + D: /api/deliver
 * C: builds the PDF server-side (pure-JS writer) and returns it as base64.
 * D: pushes the lead to HubSpot. In the prototype the payload is logged to
 *    the Netlify function logs (Site dashboard > Functions > logs, or the
 *    deploy log viewer) instead of calling the HubSpot API.
 * When HUBSPOT_ACCESS_TOKEN is added later, replace logLead() with the
 * private app token POST to /crm/v3/objects/contacts.
 */
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
function logLead(lead) {
  console.log('[hubspot-mock] lead push: ' + JSON.stringify(lead));
}

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') return json(405, { error: 'Method not allowed' });
  const body = bodyOf(event);
  const payload = core.verifyToken(body.token);
  if (!payload) return json(401, { error: 'Not signed in.' });

  const bp = body.blueprint;
  if (!bp || !bp.meta || !bp.meta.verticalLabel) return json(400, { error: 'No blueprint in request. Generate the blueprint before unlocking the PDF.' });
  const email = String(body.email || '').trim().toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return json(400, { error: 'Enter a valid email to unlock the PDF.' });
  if (body.consent !== true) return json(400, { error: 'Please tick the consent box before we send the PDF.' });

  const buffer = core.buildPdf(bp);
  const lead = core.makeLeadPayload(email, payload.name, body.fields || null, bp);
  logLead(lead);

  return {
    statusCode: 200,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
    body: JSON.stringify({
      ok: true, contact_id: lead.contact_id, lead_pushed: true,
      filename: core.pdfFilename(bp), pdf_base64: buffer.toString('base64')
    })
  };
};
