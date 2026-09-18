'use strict';
/* Netlify function B: /api/generate (mock of Claude + Prompt A + knowledge base v1) */
const core = require('../../lib/core');
const leads = require('../../lib/supabase-leads');
const { bodyOf, json } = require('../../lib/netlify-helpers');

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') return json(405, { error: 'Method not allowed' });
  const body = bodyOf(event);
  const payload = core.verifyToken(body.token);
  if (!payload) return json(401, { error: 'Your session has ended. Enter your name and email to start again.' });
  const fields = body.fields || {};
  try { if (JSON.stringify(fields).length > 100000) return json(400, { error: 'Fields payload too large.' }); } catch (e) {}
  const blueprint = core.generate(fields);
  if (payload.lead_id && leads.isEnabled(process.env)) {
    try {
      const now = new Date().toISOString();
      await leads.saveSession(payload.lead_id, { status: 'completed', extracted_fields: fields, completed_at: now }, { env: process.env });
      await leads.saveBlueprint(payload.lead_id, blueprint, { generated_at: now }, { env: process.env });
      await leads.updateLead(payload.lead_id, {
        status: 'blueprint_generated', blueprint_generated_at: now,
        industry: fields.industry || null, company: fields.business_description || null
      }, { env: process.env });
      await leads.addEvent(payload.lead_id, 'blueprint_generated', {}, { env: process.env });
    } catch (e) {
      console.error('[generate] Supabase persistence failed:', e.message);
      return json(503, { error: 'Your blueprint was generated, but we could not save it. Please try again.' });
    }
  }
  return json(200, { ok: true, blueprint });
};
