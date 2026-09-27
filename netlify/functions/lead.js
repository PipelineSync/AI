'use strict';

/* Authenticated progress updates from the PipelineSync AI journey.
 * The signed session fixes the lead ID; the browser cannot choose another row.
 */
const core = require('../../lib/core');
const leads = require('../../lib/supabase-leads');
const { bodyOf, json } = require('../../lib/netlify-helpers');

const CLIENT_STATUSES = new Set([
  'discovery_started', 'discovery_completed', 'consultation_requested'
]);

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') return json(405, { error: 'Method not allowed' });
  const body = bodyOf(event);
  let auth;
  try { auth = core.verifyToken(body.token); }
  catch (e) { return json(500, { error: 'Server session configuration is invalid.' }); }
  if (!auth) return json(401, { error: 'Your session has ended. Enter your name and email to start again.' });
  if (!auth.lead_id || !leads.isEnabled(process.env)) return json(200, { ok: true, stored: false });

  const status = String(body.status || '');
  if (!CLIENT_STATUSES.has(status)) return json(400, { error: 'Invalid lead progress status.' });
  const now = new Date().toISOString();
  const patch = { status };
  if (status === 'discovery_started') patch.discovery_started_at = now;
  if (status === 'discovery_completed') patch.discovery_completed_at = now;
  if (status === 'consultation_requested') patch.consultation_requested_at = now;

  try {
    await leads.updateLead(auth.lead_id, patch, { env: process.env });
    if (status === 'discovery_started' || status === 'discovery_completed') {
      await leads.saveSession(auth.lead_id, {
        status: status === 'discovery_completed' ? 'completed' : 'in_progress',
        answers: Array.isArray(body.answers) ? body.answers : undefined,
        voice_metadata: body.voice_meta || undefined,
        started_at: status === 'discovery_started' ? now : undefined,
        completed_at: status === 'discovery_completed' ? now : undefined
      }, { env: process.env });
    }
    const eventData = {};
    if (status === 'discovery_started') {
      if (body.consent_at) eventData.consent_at = String(body.consent_at).slice(0, 100);
      if (body.consent_version) eventData.consent_version = String(body.consent_version).slice(0, 50);
      if (body.privacy_policy_url) eventData.privacy_policy_url = String(body.privacy_policy_url).slice(0, 500);
      // Fallback to now if not provided
      if (!eventData.consent_at) eventData.consent_at = now;
      if (!eventData.consent_version) {
        try { eventData.consent_version = require('../../lib/consent').CONSENT_VERSION; } catch (e) {}
      }
    }
    await leads.addEvent(auth.lead_id, status, eventData, { env: process.env });
    return json(200, { ok: true, stored: true });
  } catch (e) {
    console.error('[lead-progress]', e.message);
    return json(503, { error: 'We could not save lead progress right now.' });
  }
};
