'use strict';

/* Server-only Supabase persistence for PipelineSync leads.
 *
 * This module talks to PostgREST directly so the zero-runtime-dependency local
 * server stays dependency-free. The secret/service-role key must never be sent
 * to public/app.js. If no Supabase variables are present (local demos/tests),
 * persistence is intentionally disabled. A partially configured environment is
 * treated as an error rather than silently losing production leads.
 */

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const STATUSES = new Set([
  'new', 'discovery_started', 'discovery_completed', 'blueprint_generated',
  'blueprint_delivered', 'consultation_requested', 'contacted', 'qualified', 'won', 'lost'
]);

function config(env) {
  env = env || process.env;
  const url = String(env.SUPABASE_URL || env.VITE_SUPABASE_URL || '').replace(/\/+$/, '');
  const key = String(env.SUPABASE_SECRET_KEY || env.SUPABASE_SERVICE_ROLE_KEY || '');
  const ownerId = String(env.PIPELINESYNC_WORKSPACE_OWNER_ID || '');
  const supplied = [url, key, ownerId].filter(Boolean).length;
  if (!supplied) return null;
  if (supplied !== 3) {
    throw new Error('Supabase lead storage needs SUPABASE_URL, SUPABASE_SECRET_KEY (or SUPABASE_SERVICE_ROLE_KEY), and PIPELINESYNC_WORKSPACE_OWNER_ID.');
  }
  if (!/^https:\/\//i.test(url) && !/^http:\/\/localhost(?::\d+)?$/i.test(url)) {
    throw new Error('SUPABASE_URL must be an HTTPS URL.');
  }
  if (!UUID_RE.test(ownerId)) throw new Error('PIPELINESYNC_WORKSPACE_OWNER_ID must be the admin auth user UUID.');
  return { url, key, ownerId };
}

async function request(path, options) {
  const opts = options || {};
  const cfg = config(opts.env);
  if (!cfg) return null;
  const fetchImpl = opts.fetchImpl || global.fetch;
  if (typeof fetchImpl !== 'function') throw new Error('This server cannot connect to Supabase because fetch is unavailable.');
  const headers = Object.assign({
    apikey: cfg.key,
    authorization: 'Bearer ' + cfg.key,
    'content-type': 'application/json',
    accept: 'application/json'
  }, opts.headers || {});
  const res = await fetchImpl(cfg.url + '/rest/v1/' + path, {
    method: opts.method || 'GET', headers,
    body: opts.body === undefined ? undefined : JSON.stringify(opts.body)
  });
  const text = await res.text();
  let data = null;
  if (text) { try { data = JSON.parse(text); } catch (e) { data = text; } }
  if (!res.ok) {
    const detail = data && typeof data === 'object' ? (data.message || data.details || data.hint) : data;
    const err = new Error('Supabase lead storage failed' + (detail ? ': ' + String(detail).slice(0, 300) : ' (HTTP ' + res.status + ')'));
    err.status = res.status;
    throw err;
  }
  return data;
}

function cleanJson(value, maxBytes) {
  if (value == null) return null;
  const raw = JSON.stringify(value);
  if (raw.length > (maxBytes || 150000)) throw new Error('Lead session data is too large to store.');
  return JSON.parse(raw);
}

async function createLead(name, email, options) {
  const cfg = config(options && options.env);
  if (!cfg) return null;
  const normalized = String(email || '').trim().toLowerCase();
  const lookup = 'pipeline_leads?user_id=eq.' + encodeURIComponent(cfg.ownerId) +
    '&email_normalized=eq.' + encodeURIComponent(normalized) +
    '&select=id,user_id,name,email,status,created_at&limit=1';
  const existing = await request(lookup, Object.assign({}, options, { method: 'GET' }));
  let rows;
  if (Array.isArray(existing) && existing.length) {
    // A returning visitor keeps their furthest journey status; only refresh identity fields.
    rows = await request(
      'pipeline_leads?id=eq.' + encodeURIComponent(existing[0].id) +
        '&user_id=eq.' + encodeURIComponent(cfg.ownerId) +
        '&select=id,user_id,name,email,status,created_at',
      Object.assign({}, options, {
        method: 'PATCH', headers: { Prefer: 'return=representation' },
        body: { name: String(name || '').trim(), email: normalized, email_normalized: normalized }
      })
    );
  } else {
    rows = await request('pipeline_leads?select=id,user_id,name,email,status,created_at',
      Object.assign({}, options, {
        method: 'POST', headers: { Prefer: 'return=representation' },
        body: {
          user_id: cfg.ownerId, name: String(name || '').trim(), email: normalized,
          email_normalized: normalized, source: 'pipelinesync_ai'
        }
      })
    );
  }
  const lead = Array.isArray(rows) ? rows[0] : rows;
  if (!lead || !lead.id) throw new Error('Supabase did not return the saved lead. Check the table schema and API access.');
  return lead;
}

async function updateLead(leadId, patch, options) {
  const cfg = config(options && options.env);
  if (!cfg || !leadId) return null;
  if (!UUID_RE.test(String(leadId))) throw new Error('Invalid lead ID.');
  const safe = Object.assign({}, patch || {});
  delete safe.id;
  delete safe.user_id;
  delete safe.email_normalized;
  if (safe.email) {
    safe.email = String(safe.email).trim().toLowerCase();
    safe.email_normalized = safe.email;
  }
  if (safe.status && !STATUSES.has(safe.status)) throw new Error('Invalid lead status.');
  const path = 'pipeline_leads?id=eq.' + encodeURIComponent(leadId) +
    '&user_id=eq.' + encodeURIComponent(cfg.ownerId) + '&select=id,status,updated_at';
  const rows = await request(path, Object.assign({}, options, {
    method: 'PATCH', headers: { Prefer: 'return=representation' }, body: safe
  }));
  if (!Array.isArray(rows) || !rows.length) throw new Error('Lead was not found in this workspace.');
  return rows[0];
}

async function saveSession(leadId, values, options) {
  const cfg = config(options && options.env);
  if (!cfg || !leadId) return null;
  const v = values || {};
  const changes = { status: v.status || 'in_progress' };
  if (v.call_id) changes.call_id = String(v.call_id).slice(0, 160);
  if (v.answers != null) changes.answers = cleanJson(v.answers);
  if (v.extracted_fields != null) changes.extracted_fields = cleanJson(v.extracted_fields);
  if (v.voice_metadata != null) changes.voice_metadata = cleanJson(v.voice_metadata);
  if (v.started_at) changes.started_at = v.started_at;
  if (v.completed_at) changes.completed_at = v.completed_at;

  // Patch existing rows so an update containing only extracted_fields cannot reset previously
  // captured answers to the column default. Insert only for the first session write.
  const found = await request(
    'pipeline_lead_sessions?lead_id=eq.' + encodeURIComponent(leadId) +
      '&user_id=eq.' + encodeURIComponent(cfg.ownerId) + '&select=id&limit=1',
    Object.assign({}, options, { method: 'GET' })
  );
  let rows;
  if (Array.isArray(found) && found.length) {
    rows = await request(
      'pipeline_lead_sessions?lead_id=eq.' + encodeURIComponent(leadId) +
        '&user_id=eq.' + encodeURIComponent(cfg.ownerId) + '&select=id,lead_id,status,updated_at',
      Object.assign({}, options, {
        method: 'PATCH', headers: { Prefer: 'return=representation' }, body: changes
      })
    );
  } else {
    rows = await request('pipeline_lead_sessions?select=id,lead_id,status,updated_at',
      Object.assign({}, options, {
        method: 'POST', headers: { Prefer: 'return=representation' },
        body: Object.assign({ user_id: cfg.ownerId, lead_id: leadId }, changes)
      })
    );
  }
  return Array.isArray(rows) ? rows[0] : rows;
}

async function saveBlueprint(leadId, blueprint, values, options) {
  const cfg = config(options && options.env);
  if (!cfg || !leadId) return null;
  const v = values || {};
  const row = {
    user_id: cfg.ownerId,
    lead_id: leadId,
    blueprint: cleanJson(blueprint, 300000),
    generated_at: v.generated_at || new Date().toISOString()
  };
  if (v.pdf_filename) row.pdf_filename = String(v.pdf_filename).slice(0, 255);
  if (v.pdf_storage_path) row.pdf_storage_path = String(v.pdf_storage_path).slice(0, 1000);
  if (v.delivered_at) row.delivered_at = v.delivered_at;
  const rows = await request(
    'pipeline_blueprints?on_conflict=lead_id&select=id,lead_id,generated_at,delivered_at',
    Object.assign({}, options, {
      method: 'POST', headers: { Prefer: 'resolution=merge-duplicates,return=representation' }, body: row
    })
  );
  return Array.isArray(rows) ? rows[0] : rows;
}

async function addEvent(leadId, eventType, eventData, options) {
  const cfg = config(options && options.env);
  if (!cfg || !leadId) return null;
  return request('pipeline_lead_events', Object.assign({}, options, {
    method: 'POST', headers: { Prefer: 'return=minimal' },
    body: {
      user_id: cfg.ownerId,
      lead_id: leadId,
      event_type: String(eventType || '').slice(0, 100),
      event_data: cleanJson(eventData || {}, 50000)
    }
  }));
}

function isEnabled(env) { return !!config(env); }

module.exports = {
  STATUSES, config, isEnabled, request, createLead, updateLead,
  saveSession, saveBlueprint, addEvent
};
