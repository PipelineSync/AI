'use strict';
/* Netlify functions C + D: /api/deliver
 * C: builds the PDF server-side (pure-JS writer) and returns it as base64.
 * D: pushes the lead to HubSpot. When HUBSPOT_ACCESS_TOKEN is set (Private App
 *    token pat-na1-...), the lead is pushed live to HubSpot Contacts + Deals
 *    via lib/hubspot.js. Without it, the payload is logged to the Netlify
 *    function logs as [hubspot-mock] (so demos never break).
 */
const core = require('../../lib/core');
const leads = require('../../lib/supabase-leads');
const hubspot = require('../../lib/hubspot');
const { bodyOf, json } = require('../../lib/netlify-helpers');
const { clampVoiceMeta } = require('../../lib/voice-api');

function logLead(lead) {
  console.log('[hubspot-mock] lead push: ' + JSON.stringify(lead));
}

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') return json(405, { error: 'Method not allowed' });
  const body = bodyOf(event);
  let payload;
  try { payload = core.verifyToken(body.token); } catch (e) {
    return json(500, { error: 'Server misconfigured: missing token secret.' });
  }
  if (!payload) return json(401, { error: 'Your session has ended. Enter your name and email to start again.' });

  const bp = body.blueprint;
  if (!bp || !bp.meta || !bp.meta.verticalLabel) return json(400, { error: 'No blueprint in request. Generate the blueprint before unlocking the PDF.' });
  const email = String(body.email || '').trim().toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return json(400, { error: 'Enter a valid email to unlock the PDF.' });
  if (email.length > 254) return json(400, { error: 'Email too long.' });
  if (body.consent !== true) return json(400, { error: 'Please tick the consent box before we send the PDF.' });

  const buffer = core.buildPdf(bp);
  const leadName = core.cleanName(payload.name) || core.loginNameFor(payload.email || email);
  const voiceMeta = clampVoiceMeta(body.voice_meta);
  const mockLead = core.makeLeadPayload(email, leadName, body.fields || null, bp, voiceMeta);

  // Push to HubSpot if configured, otherwise keep mock log so function logs still show the payload.
  let hubspotResult = null;
  let contactId = mockLead.contact_id;
  if (hubspot.isEnabled(process.env)) {
    try {
      hubspotResult = await hubspot.pushLead({
        email, name: leadName, fields: body.fields || null, blueprint: bp, voiceCall: voiceMeta,
        env: process.env, fetchImpl: globalThis.fetch
      });
      if (hubspotResult && hubspotResult.contactId) contactId = hubspotResult.contactId;
      if (hubspotResult && hubspotResult.error) {
        console.warn('[hubspot] push returned error but PDF still delivered:', hubspotResult.error);
      } else {
        console.log('[hubspot] live push ok: contact=' + (hubspotResult && hubspotResult.contactId) + ' deal=' + (hubspotResult && hubspotResult.dealId));
      }
    } catch (e) {
      console.error('[hubspot] live push failed (PDF still delivered):', e.message);
      // Do not block PDF delivery — fall back to mock id
    }
  } else {
    logLead(mockLead);
  }

  if (payload.lead_id && leads.isEnabled(process.env)) {
    try {
      const now = new Date().toISOString();
      const filename = core.pdfFilename(bp);
      await leads.saveBlueprint(payload.lead_id, bp, { generated_at: now, delivered_at: now, pdf_filename: filename }, { env: process.env });
      await leads.updateLead(payload.lead_id, {
        email, status: 'blueprint_delivered', blueprint_delivered_at: now,
        consent_given: true, consent_given_at: now
      }, { env: process.env });
      await leads.addEvent(payload.lead_id, 'blueprint_delivered', { filename }, { env: process.env });
    } catch (e) {
      console.error('[deliver] Supabase persistence failed:', e.message);
      return json(503, { error: 'The PDF was created, but delivery could not be recorded. Please try again.' });
    }
  }

  return {
    statusCode: 200,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff', 'x-frame-options': 'DENY' },
    body: JSON.stringify({
      ok: true, contact_id: contactId, lead_pushed: true,
      hubspot: hubspotResult ? { contactId: hubspotResult.contactId, dealId: hubspotResult.dealId, mocked: !!hubspotResult.mocked } : { mocked: true },
      filename: core.pdfFilename(bp), pdf_base64: buffer.toString('base64')
    })
  };
};
