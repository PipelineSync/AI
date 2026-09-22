'use strict';
/*
 * HubSpot CRM for PipelineSync AI — server-side only.
 *
 * Uses a Private App access token (pat-na1-...) stored in HUBSPOT_ACCESS_TOKEN.
 * Never reaches the browser. Called from:
 *   - start.js / server.js entry gate  → upsert contact at lead capture
 *   - deliver.js / server.js deliver   → enrich with deal + association + note
 *
 * A HubSpot outage must never fail the entry gate or block PDF delivery.
 *
 * Retry: 429 and 5xx are retried up to 3 times with exponential backoff.
 * Unknown properties: a 400 that names missing properties drops ONLY those names
 * and retries; optional HUBSPOT_AUTO_CREATE_PROPS=true creates them first.
 */

const LEAD_SOURCE = 'pipelinesync_ai';

const ASSOC = {
  DEAL_TO_CONTACT: 3,
  NOTE_TO_CONTACT: 202, // Note → Contact (201 is the reverse: Contact → Note)
  NOTE_TO_DEAL: 214
};

/* Code is the source of truth for custom property names. Types match what we send
   (strings) so auto-create does not invent a different HubSpot type than the writes. */
const CONTACT_CUSTOM_PROPERTIES = [
  { name: 'pipelinesync_source', label: 'PipelineSync Lead Source', type: 'string', fieldType: 'text', groupName: 'contactinformation', description: 'How the lead entered PipelineSync AI (pipelinesync_ai).' },
  { name: 'pipelinesync_industry', label: 'PipelineSync Industry', type: 'string', fieldType: 'text', groupName: 'contactinformation', description: 'Vertical classified from the discovery call.' },
  { name: 'pipelinesync_deal_size', label: 'PipelineSync Typical Deal Size', type: 'string', fieldType: 'text', groupName: 'contactinformation', description: 'Typical deal size as captured (string; figure in the client\'s units).' },
  { name: 'pipelinesync_monthly_leads', label: 'PipelineSync Monthly Leads', type: 'string', fieldType: 'text', groupName: 'contactinformation', description: 'Monthly lead volume as captured.' },
  { name: 'pipelinesync_close_rate', label: 'PipelineSync Close Rate', type: 'string', fieldType: 'text', groupName: 'contactinformation', description: 'Close rate as captured.' },
  { name: 'pipelinesync_monthly_deals', label: 'PipelineSync Monthly Deals', type: 'string', fieldType: 'text', groupName: 'contactinformation', description: 'Monthly closed-deal volume as captured.' },
  { name: 'pipelinesync_headache', label: 'PipelineSync Biggest Headache', type: 'string', fieldType: 'textarea', groupName: 'contactinformation', description: 'Biggest sales/marketing headache, in the client\'s words.' },
  { name: 'pipelinesync_goal', label: 'PipelineSync Six Month Goal', type: 'string', fieldType: 'textarea', groupName: 'contactinformation', description: 'Six-month goal, in the client\'s words.' },
  { name: 'pipelinesync_business_desc', label: 'PipelineSync Business Description', type: 'string', fieldType: 'textarea', groupName: 'contactinformation', description: 'Business description from the discovery call.' },
  { name: 'pipelinesync_kb_version', label: 'PipelineSync KB Version', type: 'string', fieldType: 'text', groupName: 'contactinformation', description: 'Knowledge-base version used for the blueprint.' },
  { name: 'pipelinesync_tier', label: 'PipelineSync Recommended Tier', type: 'string', fieldType: 'text', groupName: 'contactinformation', description: 'Recommended HubSpot tier from the blueprint.' },
  { name: 'pipelinesync_pipeline_variant', label: 'PipelineSync Pipeline Variant', type: 'string', fieldType: 'text', groupName: 'contactinformation', description: 'one-call or two-call pipeline variant.' },
  { name: 'pipelinesync_consent', label: 'PipelineSync Consent', type: 'string', fieldType: 'text', groupName: 'contactinformation', description: 'Consent to receive the PDF and be contacted ("true" when given).' }
];

const DEAL_CUSTOM_PROPERTIES = [
  { name: 'pipelinesync_vertical', label: 'PipelineSync Vertical', type: 'string', fieldType: 'text', groupName: 'dealinformation', description: 'Blueprint vertical label.' },
  { name: 'pipelinesync_pipeline_variant', label: 'PipelineSync Pipeline Variant', type: 'string', fieldType: 'text', groupName: 'dealinformation', description: 'one-call or two-call pipeline variant.' },
  { name: 'pipelinesync_kb_refs', label: 'PipelineSync KB References', type: 'string', fieldType: 'textarea', groupName: 'dealinformation', description: 'KB ids used in the blueprint, for audit.' },
  { name: 'pipelinesync_kb_version', label: 'PipelineSync KB Version', type: 'string', fieldType: 'text', groupName: 'dealinformation', description: 'Knowledge-base version used for the blueprint.' },
  { name: 'pipelinesync_business_desc', label: 'PipelineSync Business Description', type: 'string', fieldType: 'textarea', groupName: 'dealinformation', description: 'Business description from the discovery call.' }
];

const CONTACT_CUSTOM_NAMES = new Set(CONTACT_CUSTOM_PROPERTIES.map(p => p.name));
const DEAL_CUSTOM_NAMES = new Set(DEAL_CUSTOM_PROPERTIES.map(p => p.name));
const CONTACT_PROP_DEFS = Object.fromEntries(CONTACT_CUSTOM_PROPERTIES.map(p => [p.name, p]));
const DEAL_PROP_DEFS = Object.fromEntries(DEAL_CUSTOM_PROPERTIES.map(p => [p.name, p]));

const MAX_TRIES = 3;
const BACKOFF_MS = 200;

function defaultSleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}
let sleepImpl = defaultSleep;
let propsEnsured = false;

function setSleep(fn) {
  sleepImpl = typeof fn === 'function' ? fn : defaultSleep;
}
function resetForTests() {
  propsEnsured = false;
}

function hubspotConfig(env) {
  env = env || process.env;
  const token = String(
    env.HUBSPOT_ACCESS_TOKEN ||
    env.HUBSPOT_API_KEY ||
    env.HUBSPOT_TOKEN ||
    ''
  ).trim();
  if (!token) return null;
  if (token.length < 20) console.warn('[hubspot] token looks too short');
  return { token, baseUrl: 'https://api.hubapi.com' };
}

function isEnabled(env) {
  return !!hubspotConfig(env);
}

function autoCreateProps(env) {
  const v = String((env || process.env).HUBSPOT_AUTO_CREATE_PROPS || '').trim().toLowerCase();
  return v === '1' || v === 'true' || v === 'yes' || v === 'on';
}

function splitName(full) {
  const parts = String(full || '').trim().split(/\s+/).filter(Boolean);
  if (!parts.length) return { firstname: 'Lead', lastname: '' };
  if (parts.length === 1) return { firstname: parts[0], lastname: '' };
  return { firstname: parts[0], lastname: parts.slice(1).join(' ') };
}

function retryAfterMs(res, attempt) {
  let wait = BACKOFF_MS * Math.pow(2, attempt);
  try {
    const ra = res && res.headers && typeof res.headers.get === 'function'
      ? res.headers.get('retry-after') || res.headers.get('Retry-After')
      : null;
    const n = ra != null ? parseInt(ra, 10) : NaN;
    if (Number.isFinite(n) && n >= 0) wait = Math.min(n * 1000, 5000);
  } catch (e) { /* ignore */ }
  return Math.min(wait, 5000);
}

async function hubspotFetch(path, opts) {
  const { token, baseUrl, method, body, fetchImpl } = opts;
  const fetchFn = fetchImpl || globalThis.fetch;
  if (typeof fetchFn !== 'function') throw new Error('fetch not available for HubSpot');
  const headers = {
    Authorization: 'Bearer ' + token,
    'Content-Type': 'application/json',
    Accept: 'application/json'
  };
  let lastErr = null;
  for (let attempt = 0; attempt < MAX_TRIES; attempt++) {
    let res;
    try {
      res = await fetchFn(baseUrl + path, {
        method: method || 'GET',
        headers,
        body: body === undefined ? undefined : JSON.stringify(body)
      });
    } catch (e) {
      lastErr = e;
      lastErr.status = lastErr.status || 0;
      if (attempt === MAX_TRIES - 1) throw lastErr;
      await sleepImpl(retryAfterMs(null, attempt));
      continue;
    }
    const text = await res.text();
    let data = null;
    if (text) {
      try { data = JSON.parse(text); } catch (e) { data = text; }
    }
    if (res.ok) return data;
    const detail = data && typeof data === 'object'
      ? (data.message || data.details || data.hint || JSON.stringify(data).slice(0, 600))
      : String(data || '').slice(0, 600);
    const err = new Error('HubSpot ' + path + ' failed: ' + (detail || 'HTTP ' + res.status));
    err.status = res.status;
    err.data = data;
    lastErr = err;
    const retryable = res.status === 429 || (res.status >= 500 && res.status <= 599);
    if (!retryable || attempt === MAX_TRIES - 1) throw err;
    await sleepImpl(retryAfterMs(res, attempt));
  }
  throw lastErr;
}

/* Pull property names HubSpot rejected. Only names that were actually submitted are returned,
   so a stray "email" in the error JSON cannot wipe identity fields. */
function parseUnknownPropertyNames(err, submittedKeys) {
  const names = new Set();
  const submitted = submittedKeys ? new Set(submittedKeys) : null;
  const blobs = [];
  if (err && err.message) blobs.push(String(err.message));
  const data = err && err.data;
  if (typeof data === 'string') blobs.push(data);
  if (data && typeof data === 'object') {
    if (data.message) blobs.push(String(data.message));
    if (Array.isArray(data.errors)) {
      for (const e of data.errors) {
        if (!e) continue;
        if (e.name) names.add(String(e.name));
        if (e.message) blobs.push(String(e.message));
        const ctx = e.context || {};
        for (const key of ['propertyName', 'name', 'properties']) {
          if (Array.isArray(ctx[key])) ctx[key].forEach(n => names.add(String(n)));
        }
      }
    }
  }
  for (const blob of blobs) {
    const jsonStart = blob.indexOf('[');
    if (jsonStart >= 0) {
      const slice = blob.slice(jsonStart);
      const jsonEnd = slice.lastIndexOf(']');
      if (jsonEnd >= 0) {
        try {
          const arr = JSON.parse(slice.slice(0, jsonEnd + 1));
          if (Array.isArray(arr)) {
            for (const item of arr) {
              if (item && item.name) names.add(String(item.name));
            }
          }
        } catch (e) { /* not JSON; fall through to regex */ }
      }
    }
    const reQuoted = /Property\s+"([A-Za-z][A-Za-z0-9_]*)"\s+does not exist/gi;
    let m;
    while ((m = reQuoted.exec(blob))) names.add(m[1]);
    const reName = /"name"\s*:\s*"([A-Za-z][A-Za-z0-9_]*)"/g;
    while ((m = reName.exec(blob))) names.add(m[1]);
  }
  let out = Array.from(names);
  if (submitted) out = out.filter(n => submitted.has(n));
  return out;
}

function dropNames(props, names) {
  const next = Object.assign({}, props);
  for (const n of names) delete next[n];
  return next;
}

async function createProperty(objectType, def, cfg, fetchImpl) {
  if (!def || !def.name) return false;
  try {
    await hubspotFetch('/crm/v3/properties/' + objectType, {
      token: cfg.token, baseUrl: cfg.baseUrl, method: 'POST', fetchImpl,
      body: {
        name: def.name,
        label: def.label || def.name,
        type: def.type || 'string',
        fieldType: def.fieldType || 'text',
        groupName: def.groupName || (objectType === 'deals' ? 'dealinformation' : 'contactinformation'),
        description: def.description || 'Created by PipelineSync AI',
        hasUniqueValue: false
      }
    });
    return true;
  } catch (e) {
    if (e.status === 409 || /already exists/i.test(e.message || '')) return true;
    console.warn('[hubspot] could not auto-create ' + objectType + '.' + def.name + ':', e.message);
    return false;
  }
}

async function ensureCustomPropertiesOnce(cfg, env, fetchImpl) {
  if (!autoCreateProps(env) || propsEnsured) return;
  propsEnsured = true;
  for (const def of CONTACT_CUSTOM_PROPERTIES) {
    await createProperty('contacts', def, cfg, fetchImpl);
  }
  for (const def of DEAL_CUSTOM_PROPERTIES) {
    await createProperty('deals', def, cfg, fetchImpl);
  }
}

async function createMissingProperties(objectType, names, cfg, fetchImpl) {
  const defs = objectType === 'deals' ? DEAL_PROP_DEFS : CONTACT_PROP_DEFS;
  for (const name of names) {
    if (defs[name]) await createProperty(objectType, defs[name], cfg, fetchImpl);
  }
}

async function writeWithPropertyFallback(write, props, objectType, cfg, fetchImpl, env) {
  let current = Object.assign({}, props);
  let lastErr = null;
  const custom = objectType === 'deals' ? DEAL_CUSTOM_NAMES : CONTACT_CUSTOM_NAMES;
  for (let i = 0; i < 4; i++) {
    try {
      return await write(current);
    } catch (e) {
      lastErr = e;
      if (e.status !== 400) throw e;
      let unknown = parseUnknownPropertyNames(e, Object.keys(current));
      if (!unknown.length) {
        const next = {};
        for (const [k, v] of Object.entries(current)) {
          if (!custom.has(k)) next[k] = v;
        }
        if (Object.keys(next).length === Object.keys(current).length) throw e;
        current = next;
        continue;
      }
      if (autoCreateProps(env)) {
        await createMissingProperties(objectType, unknown, cfg, fetchImpl);
        try { return await write(props); } catch (e2) { lastErr = e2; }
        unknown = parseUnknownPropertyNames(lastErr, Object.keys(current));
        if (!unknown.length) throw lastErr;
      }
      const next = dropNames(current, unknown);
      if (Object.keys(next).length === Object.keys(current).length) throw e;
      current = next;
    }
  }
  throw lastErr;
}

async function searchContactByEmail(email, cfg, fetchImpl) {
  const body = {
    filterGroups: [{ filters: [{ propertyName: 'email', operator: 'EQ', value: email }] }],
    properties: ['email', 'firstname', 'lastname', 'lifecyclestage', 'hs_lead_status'],
    limit: 1
  };
  const data = await hubspotFetch('/crm/v3/objects/contacts/search', {
    token: cfg.token, baseUrl: cfg.baseUrl, method: 'POST', body, fetchImpl
  });
  if (data && Array.isArray(data.results) && data.results.length) return data.results[0];
  return null;
}

function buildContactProperties(email, name, fields, blueprint, opts) {
  opts = opts || {};
  const { firstname, lastname } = splitName(name);
  const bp = blueprint || {};
  const meta = bp.meta || {};
  const onCreate = !!opts.onCreate;
  const props = {
    email: email,
    firstname: firstname,
    lastname: lastname
  };
  // lifecycle + lead status are set ONLY on create so a returning visitor is never demoted.
  if (onCreate) {
    props.lifecyclestage = 'lead';
    props.hs_lead_status = 'NEW';
  }
  const source = opts.leadSource != null ? String(opts.leadSource).trim() : LEAD_SOURCE;
  if (source) props.pipelinesync_source = source.slice(0, 200);

  const ft = fields || {};
  const map = {
    pipelinesync_industry: ft.industry || meta.vertical || null,
    pipelinesync_deal_size: ft.typical_deal_size != null ? String(ft.typical_deal_size) : null,
    pipelinesync_monthly_leads: ft.monthly_lead_volume != null ? String(ft.monthly_lead_volume) : null,
    pipelinesync_close_rate: ft.close_rate != null ? String(ft.close_rate) : null,
    pipelinesync_monthly_deals: ft.monthly_deal_volume != null ? String(ft.monthly_deal_volume) : null,
    pipelinesync_headache: ft.biggest_headache ? String(ft.biggest_headache).slice(0, 1000) : null,
    pipelinesync_goal: ft.six_month_goal ? String(ft.six_month_goal).slice(0, 1000) : null,
    pipelinesync_business_desc: ft.business_description ? String(ft.business_description).slice(0, 1000) : null,
    pipelinesync_kb_version: meta.kb_version || (bp.meta ? 'v1' : null),
    pipelinesync_tier: (bp.stack && bp.stack.tier) ? String(bp.stack.tier).slice(0, 200) : null,
    pipelinesync_pipeline_variant: (bp.pipeline && bp.pipeline.variant) ? String(bp.pipeline.variant).slice(0, 50) : null,
    pipelinesync_consent: opts.consent ? 'true' : null
  };
  for (const [k, v] of Object.entries(map)) {
    if (v != null && String(v).trim() !== '') props[k] = String(v);
  }
  return props;
}

function buildDealProperties(email, name, fields, blueprint) {
  const bp = blueprint || {};
  const meta = bp.meta || {};
  const coa = bp.coa || {};
  const first = splitName(name).firstname;
  const dateStr = new Date().toISOString().slice(0, 10);
  const vertical = meta.verticalLabel || (fields && fields.industry) || 'Blueprint';
  const dealname = `${first} — ${vertical} Blueprint — ${dateStr}`;
  const amount = fields && fields.typical_deal_size != null ? String(fields.typical_deal_size) : null;
  const closedate = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString();
  const summary = bp.summary && bp.summary.text ? String(bp.summary.text).slice(0, 800) : '';
  const kbRefs = Array.isArray(bp.kbReferences) ? bp.kbReferences.join(', ') : '';
  const pipelineLabel = bp.pipeline ? `${bp.pipeline.label} (${bp.pipeline.variant})` : '';
  const tier = bp.stack ? bp.stack.tier : '';
  const coaLine = coa.totalMonthly != null ? `Est. cost of inaction: PHP ${Number(coa.totalMonthly).toLocaleString('en-PH')}/mo` : '';
  const description = [
    `PipelineSync AI — Revenue Operations Blueprint`,
    `Contact: ${name} <${email}>`,
    `Vertical: ${vertical} | Tier: ${tier} | Pipeline: ${pipelineLabel}`,
    ``,
    summary,
    ``,
    coaLine,
    kbRefs ? `KB refs: ${kbRefs}` : '',
    `Source: pipelinesync-ai-blueprint | Consent: true`
  ].filter(Boolean).join('\n').slice(0, 5000);

  const props = {
    dealname,
    description,
    amount: amount || undefined,
    closedate
  };
  const customs = {
    pipelinesync_vertical: vertical ? String(vertical).slice(0, 200) : null,
    pipelinesync_pipeline_variant: bp.pipeline && bp.pipeline.variant ? String(bp.pipeline.variant).slice(0, 50) : null,
    pipelinesync_kb_refs: kbRefs ? String(kbRefs).slice(0, 1000) : null,
    pipelinesync_kb_version: meta.kb_version ? String(meta.kb_version).slice(0, 20) : null,
    pipelinesync_business_desc: fields && fields.business_description ? String(fields.business_description).slice(0, 1000) : null
  };
  for (const [k, v] of Object.entries(customs)) {
    if (v != null && String(v).trim() !== '') props[k] = String(v);
  }
  for (const k of Object.keys(props)) if (props[k] === undefined) delete props[k];
  return props;
}

async function createContact(props, cfg, fetchImpl) {
  return hubspotFetch('/crm/v3/objects/contacts', {
    token: cfg.token, baseUrl: cfg.baseUrl, method: 'POST', body: { properties: props }, fetchImpl
  });
}

async function updateContact(contactId, props, cfg, fetchImpl) {
  return hubspotFetch('/crm/v3/objects/contacts/' + encodeURIComponent(contactId), {
    token: cfg.token, baseUrl: cfg.baseUrl, method: 'PATCH', body: { properties: props }, fetchImpl
  });
}

async function createDeal(props, cfg, fetchImpl) {
  return hubspotFetch('/crm/v3/objects/deals', {
    token: cfg.token, baseUrl: cfg.baseUrl, method: 'POST', body: { properties: props }, fetchImpl
  });
}

async function writeObject(kind, objectType, id, props, cfg, fetchImpl, env) {
  const write = (p) => {
    if (kind === 'create' && objectType === 'contacts') return createContact(p, cfg, fetchImpl);
    if (kind === 'update' && objectType === 'contacts') return updateContact(id, p, cfg, fetchImpl);
    if (kind === 'create' && objectType === 'deals') return createDeal(p, cfg, fetchImpl);
    throw new Error('unsupported write ' + kind + ' ' + objectType);
  };
  return writeWithPropertyFallback(write, props, objectType, cfg, fetchImpl, env);
}

async function associateDealToContact(dealId, contactId, cfg, fetchImpl) {
  const v4Body = [{ associationCategory: 'HUBSPOT_DEFINED', associationTypeId: ASSOC.DEAL_TO_CONTACT }];
  try {
    await hubspotFetch(`/crm/v4/objects/deals/${encodeURIComponent(dealId)}/associations/contacts/${encodeURIComponent(contactId)}`, {
      token: cfg.token, baseUrl: cfg.baseUrl, method: 'PUT', body: v4Body, fetchImpl
    });
    return true;
  } catch (e) {
    if (e.status === 404) {
      try {
        await hubspotFetch(`/crm/v3/objects/deals/${encodeURIComponent(dealId)}/associations/contacts/${encodeURIComponent(contactId)}/${ASSOC.DEAL_TO_CONTACT}`, {
          token: cfg.token, baseUrl: cfg.baseUrl, method: 'PUT', fetchImpl
        });
        return true;
      } catch (e2) {
        console.warn('[hubspot] association fallback failed:', e2.message);
        return false;
      }
    }
    console.warn('[hubspot] association failed:', e.message);
    return false;
  }
}

/* Phase 3: the note also records how the emailed PDF went, so HubSpot shows the same truth the
   browser was shown: sent (with the Resend id) or not sent (with the reason). An absent result
   means the caller did not attempt an email, and no line is written. */
function emailNoteLine(emailResult) {
  if (!emailResult) return '';
  if (emailResult.sent) {
    return `Email: sent to ${emailResult.to || 'the lead'}${emailResult.id ? ' (Resend ' + emailResult.id + ')' : ''} with the PDF attached`;
  }
  return `Email: NOT sent - ${String(emailResult.error || 'unknown error').slice(0, 300)}`;
}

/* Phase 4: the note left on the contact when the HubSpot Meetings scheduler reports a
   booking. `meeting` is the sanitised postMessage detail from lib/booked-core.js (an object
   of short strings/numbers only), so it is safe to render into the note body. */
function bookingNoteBody(meeting) {
  const m = (meeting && typeof meeting === 'object') ? meeting : {};
  const lines = ['PipelineSync AI — Consultation booked via the scheduler'];
  const pick = (label, v) => {
    const s = String(v == null ? '' : v).slice(0, 200);
    if (s) lines.push(label + ': ' + s);
  };
  pick('Date', m.date || m.startTimeLocalized || m.start_time_localized);
  pick('Start (UTC ms)', m.startTimeUtc != null ? m.startTimeUtc : m.start_time_utc);
  pick('Duration (ms)', m.duration);
  pick('Meeting type', m.meetingType || m.meeting_type);
  pick('Scheduler link', m.linkUrl || m.link_url);
  pick('Form', m.formGuid || m.form_guid);
  lines.push('Booked by the lead in the HubSpot Meetings embed on the PipelineSync AI site.');
  return lines.join('\n').slice(0, 2000);
}

async function createBookingNote(contactId, meeting, cfg, fetchImpl) {
  if (!contactId) return null;
  const noteProps = {
    hs_note_body: bookingNoteBody(meeting),
    hs_timestamp: new Date().toISOString()
  };
  try {
    const note = await hubspotFetch('/crm/v3/objects/notes', {
      token: cfg.token, baseUrl: cfg.baseUrl, method: 'POST', body: { properties: noteProps }, fetchImpl
    });
    const noteId = note && note.id;
    if (noteId) {
      try {
        await hubspotFetch(`/crm/v4/objects/notes/${encodeURIComponent(noteId)}/associations/contacts/${encodeURIComponent(contactId)}`, {
          token: cfg.token, baseUrl: cfg.baseUrl, method: 'PUT',
          body: [{ associationCategory: 'HUBSPOT_DEFINED', associationTypeId: ASSOC.NOTE_TO_CONTACT }],
          fetchImpl
        });
      } catch (e) { console.warn('[hubspot] booking note->contact association failed:', e.message); }
    }
    return note;
  } catch (e) {
    console.warn('[hubspot] booking note creation failed:', e.message);
    return null;
  }
}

/* Phase 4: record a scheduler booking on the contact (contact resolve + note). Never throws:
   a HubSpot outage must not fail /api/lead/booked, it is reported as ok:false instead. */
async function recordBooking({ email, name, contactId, meeting, env, fetchImpl }) {
  const cfg = hubspotConfig(env);
  if (!cfg) return { ok: false, mocked: true };
  try {
    let id = contactId ? String(contactId) : null;
    if (!id) {
      const upserted = await upsertContact({ email, name, leadSource: LEAD_SOURCE, env, fetchImpl });
      if (upserted && upserted.contactId) id = upserted.contactId;
    }
    if (!id) return { ok: false, mocked: false, error: 'Could not resolve the HubSpot contact.' };
    const note = await createBookingNote(id, meeting, cfg, fetchImpl);
    if (!note || !note.id) return { ok: false, mocked: false, contactId: id, error: 'The booking note could not be saved to HubSpot.' };
    console.log(`[hubspot] booking recorded: contact=${id} note=${note.id}`);
    return { ok: true, mocked: false, contactId: id, noteId: note.id };
  } catch (e) {
    console.warn('[hubspot] recordBooking failed:', e.message);
    return { ok: false, mocked: false, error: e.message };
  }
}

async function createNoteForContact(contactId, dealId, fields, blueprint, voiceCall, cfg, fetchImpl, emailResult) {
  if (!contactId) return null;
  const bp = blueprint || {};
  const summary = bp.summary ? bp.summary.text : '';
  const noteBody = [
    `PipelineSync AI — Blueprint delivered`,
    `Vertical: ${bp.meta?.verticalLabel || 'n/a'} | Tier: ${bp.stack?.tier || 'n/a'}`,
    `Pipeline: ${bp.pipeline?.label || 'n/a'} (${bp.pipeline?.variant || 'n/a'})`,
    ``,
    summary ? `Summary: ${String(summary).slice(0, 600)}` : '',
    fields?.biggest_headache ? `Headache: ${String(fields.biggest_headache).slice(0, 400)}` : '',
    fields?.six_month_goal ? `Goal: ${String(fields.six_month_goal).slice(0, 400)}` : '',
    ``,
    `KB refs: ${(bp.kbReferences || []).join(', ')}`,
    voiceCall ? `Voice: ${voiceCall.provider || ''} ${voiceCall.mode || ''} turns=${voiceCall.turns || ''}` : '',
    `PDF: ${bp.meta ? 'PipelineSync_Blueprint_' + (bp.meta.verticalLabel || '').replace(/\s+/g, '') + '_' + new Date().toISOString().slice(0, 10) + '.pdf' : ''}`,
    emailNoteLine(emailResult),
    `audio_retained: false`
  ].filter(Boolean).join('\n').slice(0, 5000);

  const noteProps = {
    hs_note_body: noteBody,
    hs_timestamp: new Date().toISOString()
  };
  try {
    const note = await hubspotFetch('/crm/v3/objects/notes', {
      token: cfg.token, baseUrl: cfg.baseUrl, method: 'POST', body: { properties: noteProps }, fetchImpl
    });
    const noteId = note && note.id;
    if (noteId) {
      try {
        await hubspotFetch(`/crm/v4/objects/notes/${encodeURIComponent(noteId)}/associations/contacts/${encodeURIComponent(contactId)}`, {
          token: cfg.token, baseUrl: cfg.baseUrl, method: 'PUT',
          body: [{ associationCategory: 'HUBSPOT_DEFINED', associationTypeId: ASSOC.NOTE_TO_CONTACT }],
          fetchImpl
        });
      } catch (e) { console.warn('[hubspot] note->contact association failed:', e.message); }
      if (dealId) {
        try {
          await hubspotFetch(`/crm/v4/objects/notes/${encodeURIComponent(noteId)}/associations/deals/${encodeURIComponent(dealId)}`, {
            token: cfg.token, baseUrl: cfg.baseUrl, method: 'PUT',
            body: [{ associationCategory: 'HUBSPOT_DEFINED', associationTypeId: ASSOC.NOTE_TO_DEAL }],
            fetchImpl
          });
        } catch (e) { console.warn('[hubspot] note->deal association failed:', e.message); }
      }
    }
    return note;
  } catch (e) {
    console.warn('[hubspot] note creation failed:', e.message);
    return null;
  }
}

async function upsertContact({ email, name, fields, blueprint, leadSource, contactId, consent, env, fetchImpl }) {
  const cfg = hubspotConfig(env);
  if (!cfg) return { enabled: false, mocked: true, contactId: null };

  await ensureCustomPropertiesOnce(cfg, env, fetchImpl);

  const normalizedEmail = String(email || '').trim().toLowerCase();
  if (!normalizedEmail || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(normalizedEmail)) {
    throw new Error('Invalid email for HubSpot push');
  }

  let id = contactId ? String(contactId) : null;
  let contact = null;

  if (!id) {
    try {
      contact = await searchContactByEmail(normalizedEmail, cfg, fetchImpl);
      if (contact && contact.id) id = contact.id;
    } catch (e) {
      console.warn('[hubspot] contact search failed:', e.message);
    }
  }

  const source = leadSource || LEAD_SOURCE;

  const writeUpdate = async (existingId, onCreate) => {
    const props = buildContactProperties(normalizedEmail, name, fields, blueprint, {
      onCreate: !!onCreate, leadSource: source, consent: !!consent
    });
    return writeObject(onCreate ? 'create' : 'update', 'contacts', existingId, props, cfg, fetchImpl, env);
  };

  try {
    if (id) {
      try {
        const updated = await writeUpdate(id, false);
        return {
          enabled: true, mocked: false,
          contactId: (updated && updated.id) || id,
          contact: updated, createdContact: false
        };
      } catch (e) {
        if (e.status !== 404) throw e;
        id = null;
      }
    }
    try {
      const created = await writeUpdate(null, true);
      return {
        enabled: true, mocked: false,
        contactId: created && created.id,
        contact: created, createdContact: true
      };
    } catch (e) {
      if (e.status === 409 || /already exists/i.test(e.message || '')) {
        console.warn('[hubspot] contact already exists, re-searching');
        const again = await searchContactByEmail(normalizedEmail, cfg, fetchImpl);
        if (again && again.id) {
          const updated = await writeUpdate(again.id, false);
          return {
            enabled: true, mocked: false,
            contactId: (updated && updated.id) || again.id,
            contact: updated || again, createdContact: false
          };
        }
      }
      throw e;
    }
  } catch (e) {
    console.error('[hubspot] contact upsert failed:', e.message);
    return { enabled: true, mocked: false, contactId: id, error: e.message, contact, createdContact: false };
  }
}

async function captureLead({ email, name, env, fetchImpl }) {
  if (!isEnabled(env)) return { ok: false, mocked: true };
  try {
    const r = await upsertContact({
      email, name, leadSource: LEAD_SOURCE, env, fetchImpl
    });
    if (!r || r.mocked) return { ok: false, mocked: true };
    const out = {
      ok: !!(r.contactId && !r.error),
      mocked: false
    };
    if (r.contactId) out.contactId = r.contactId;
    if (r.error) out.error = r.error;
    return out;
  } catch (e) {
    console.warn('[hubspot] captureLead failed:', e.message);
    return { ok: false, mocked: false, error: e.message };
  }
}

function publicHubspot(result) {
  if (!result || result.mocked || result.enabled === false) {
    return { ok: false, mocked: true };
  }
  const out = {
    ok: !!(result.contactId && !result.error),
    mocked: false
  };
  if (result.contactId) out.contactId = result.contactId;
  if (result.dealId) out.dealId = result.dealId;
  if (result.error) out.error = result.error;
  if (result.dealError) out.dealError = result.dealError;
  return out;
}

async function pushLead({ email, name, fields, blueprint, voiceCall, contactId, emailResult, env, fetchImpl }) {
  const cfg = hubspotConfig(env);
  if (!cfg) return { enabled: false, contactId: null, dealId: null, mocked: true };

  const upsert = await upsertContact({
    email, name, fields, blueprint,
    leadSource: LEAD_SOURCE,
    contactId: contactId || null,
    consent: true,
    env, fetchImpl
  });
  if (upsert.mocked) return { enabled: false, contactId: null, dealId: null, mocked: true };
  if (!upsert.contactId) {
    return {
      enabled: true, mocked: false, contactId: null, dealId: null,
      error: upsert.error || 'contact upsert failed', contact: upsert.contact
    };
  }

  const id = upsert.contactId;
  let dealId = null;
  let deal = null;
  try {
    const dealProps = buildDealProperties(String(email || '').trim().toLowerCase(), name, fields, blueprint);
    deal = await writeObject('create', 'deals', null, dealProps, cfg, fetchImpl, env);
    dealId = deal && deal.id;
    if (dealId && id) {
      await associateDealToContact(dealId, id, cfg, fetchImpl);
    }
  } catch (e) {
    console.error('[hubspot] deal creation failed:', e.message);
    return {
      enabled: true, mocked: false, contactId: id, dealId: null,
      dealError: e.message, contact: upsert.contact, deal,
      createdContact: upsert.createdContact
    };
  }

  try {
    await createNoteForContact(id, dealId, fields, blueprint, voiceCall, cfg, fetchImpl, emailResult);
  } catch (e) {
    console.warn('[hubspot] note step failed:', e.message);
  }

  console.log(`[hubspot] lead push: contact=${id} deal=${dealId || 'none'} email=${String(email || '').trim().toLowerCase()} createdContact=${!!upsert.createdContact}`);
  return {
    enabled: true, mocked: false, contactId: id, dealId,
    contact: upsert.contact, deal, createdContact: upsert.createdContact
  };
}

module.exports = {
  hubspotConfig,
  isEnabled,
  splitName,
  buildContactProperties,
  buildDealProperties,
  searchContactByEmail,
  createContact,
  updateContact,
  createDeal,
  associateDealToContact,
  upsertContact,
  captureLead,
  pushLead,
  recordBooking,
  bookingNoteBody,
  emailNoteLine,
  publicHubspot,
  parseUnknownPropertyNames,
  setSleep,
  resetForTests,
  ASSOC,
  LEAD_SOURCE,
  CONTACT_CUSTOM_PROPERTIES,
  DEAL_CUSTOM_PROPERTIES,
  MAX_TRIES
};
