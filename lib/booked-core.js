'use strict';
/* Phase 4: shared /api/lead/booked logic, mounted by netlify/functions/lead-booked.js
 * and by server.js so the deployed and local paths cannot drift apart.
 *
 * The browser calls this only after the HubSpot Meetings iframe posted a booking-success
 * message from a HubSpot meetings origin (verified client-side). The endpoint records it:
 *   - Supabase (when configured): the lead keeps status 'consultation_requested' — the
 *     schema has no separate booked status — with a fresh consultation_requested_at and a
 *     'consultation_booked' timeline event carrying the meeting detail;
 *   - HubSpot (when configured): a "Consultation booked" note on the contact.
 *
 * Returns { statusCode, body }. body.ok === true is the ONLY thing that lets the UI show
 * "Meeting booked". A HubSpot outage never fails the request (reported inside the body);
 * a Supabase outage does (503), because a configured store must not silently lose bookings.
 */
const core = require('./core');
const leads = require('./supabase-leads');
const hubspot = require('./hubspot');

const MAX_MEETING_BYTES = 4000;

/* Keep only short strings and finite numbers, one level deep. Anything else from the
   postMessage payload (functions, nested objects, huge blobs) is dropped. */
function sanitizeMeeting(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const out = {};
  const putStr = (k, v) => {
    if (typeof v === 'string' && v) out[k] = v.slice(0, 200);
    else if (typeof v === 'number' && Number.isFinite(v)) out[k] = v;
  };
  const flat = ['date', 'startTimeLocalized', 'start_time_localized', 'meetingType', 'meeting_type',
    'linkUrl', 'link_url', 'formGuid', 'form_guid', 'startTimeUtc', 'start_time_utc', 'duration'];
  for (const k of flat) if (raw[k] != null) putStr(k, raw[k]);
  const nested = raw.bookedMeeting || raw.booked_meeting || raw.meetingsPayload || raw.meetings_payload;
  if (nested && typeof nested === 'object') {
    for (const k of flat) if (nested[k] != null && out[k] == null) putStr(k, nested[k]);
    const when = nested.event || nested.dateString;
    if (typeof when === 'string' && when && !out.date) out.date = when.slice(0, 200);
  }
  if (!Object.keys(out).length) return null;
  try {
    if (JSON.stringify(out).length > MAX_MEETING_BYTES) return null;
  } catch (e) { return null; }
  return out;
}

function publicHubspot(result) {
  if (!result || result.mocked) return { ok: false, mocked: true };
  const out = { ok: !!result.ok, mocked: false };
  if (result.contactId) out.contactId = result.contactId;
  if (result.noteId) out.noteId = result.noteId;
  if (result.error) out.error = String(result.error).slice(0, 300);
  return out;
}

async function record(opts) {
  const o = opts || {};
  const env = o.env || process.env;
  const body = o.body || {};
  const fetchImpl = o.fetchImpl || (typeof globalThis.fetch === 'function' ? globalThis.fetch : null);

  let payload;
  try {
    payload = core.verifyToken(body.token);
  } catch (e) {
    return { statusCode: 500, body: { error: 'Server session configuration is invalid.' } };
  }
  if (!payload) {
    return { statusCode: 401, body: { error: 'Your session has ended. Enter your name and email to start again.' } };
  }

  const meeting = sanitizeMeeting(body.meeting);
  let supabaseStored = false;

  if (payload.lead_id && leads.isEnabled(env)) {
    try {
      const now = new Date().toISOString();
      await leads.updateLead(payload.lead_id, {
        status: 'consultation_requested', consultation_requested_at: now
      }, { env });
      await leads.addEvent(payload.lead_id, 'consultation_booked', meeting ? { meeting } : {}, { env });
      supabaseStored = true;
    } catch (e) {
      console.error('[lead-booked] Supabase persistence failed:', e.message);
      return { statusCode: 503, body: { error: 'We could not record the booking right now. Your time in the scheduler still stands — please try again.' } };
    }
  }

  let hubspotResult = null;
  if (hubspot.isEnabled(env)) {
    hubspotResult = await hubspot.recordBooking({
      email: payload.email, name: payload.name,
      contactId: payload.hubspot_contact_id || null,
      meeting, env, fetchImpl
    });
  } else {
    console.log('[hubspot-mock] booking recorded for ' + (payload.email || 'unknown'));
  }

  return {
    statusCode: 200,
    body: { ok: true, recorded: { supabase: supabaseStored, hubspot: publicHubspot(hubspotResult) } }
  };
}

module.exports = { sanitizeMeeting, record };
