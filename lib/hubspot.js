'use strict';
/*
 * HubSpot CRM push for PipelineSync AI — server-side only.
 *
 * Uses a Private App access token (pat-na1-...) stored in HUBSPOT_ACCESS_TOKEN.
 * Never reaches the browser — called from server.js and netlify/functions/deliver.js
 * after the PDF is built, so a HubSpot outage never blocks delivery.
 *
 * Flow (all HubSpot calls are optional, failures are logged not thrown):
 *   1. Search contacts by email (POST /crm/v3/objects/contacts/search)
 *   2. Create or update contact with standard + PipelineSync custom props
 *   3. Create deal (POST /crm/v3/objects/deals) with blueprint summary
 *   4. Associate deal <-> contact (PUT /crm/v4/associations)
 *   5. Optionally add a note with the full blueprint payload
 *
 * If any step fails because custom properties don't exist yet, we retry with
 * only standard properties so the contact still lands.
 * If HUBSPOT_ACCESS_TOKEN is not set, the caller should keep the mock log.
 */

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

function splitName(full) {
  const parts = String(full || '').trim().split(/\s+/).filter(Boolean);
  if (!parts.length) return { firstname: 'Lead', lastname: '' };
  if (parts.length === 1) return { firstname: parts[0], lastname: '' };
  return { firstname: parts[0], lastname: parts.slice(1).join(' ') };
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
  const res = await fetchFn(baseUrl + path, {
    method: method || 'GET',
    headers,
    body: body === undefined ? undefined : JSON.stringify(body)
  });
  const text = await res.text();
  let data = null;
  if (text) {
    try { data = JSON.parse(text); } catch (e) { data = text; }
  }
  if (!res.ok) {
    const detail = data && typeof data === 'object'
      ? (data.message || data.details || data.hint || JSON.stringify(data).slice(0, 600))
      : String(data || '').slice(0, 600);
    const err = new Error('HubSpot ' + path + ' failed: ' + (detail || 'HTTP ' + res.status));
    err.status = res.status;
    err.data = data;
    throw err;
  }
  return data;
}

async function searchContactByEmail(email, cfg, fetchImpl) {
  const body = {
    filterGroups: [{ filters: [{ propertyName: 'email', operator: 'EQ', value: email }] }],
    properties: ['email', 'firstname', 'lastname', 'lifecyclestage'],
    limit: 1
  };
  const data = await hubspotFetch('/crm/v3/objects/contacts/search', {
    token: cfg.token, baseUrl: cfg.baseUrl, method: 'POST', body, fetchImpl
  });
  if (data && Array.isArray(data.results) && data.results.length) return data.results[0];
  return null;
}

function buildContactProperties(email, name, fields, blueprint) {
  const { firstname, lastname } = splitName(name);
  const bp = blueprint || {};
  const meta = bp.meta || {};
  const props = {
    email: email,
    firstname: firstname,
    lastname: lastname,
    lifecyclestage: 'lead',
    hs_lead_status: 'NEW'
  };
  // Only set if we have a value — HubSpot rejects empty for some types
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
    pipelinesync_kb_version: meta.kb_version || 'v1',
    pipelinesync_tier: (bp.stack && bp.stack.tier) ? String(bp.stack.tier).slice(0, 200) : null,
    pipelinesync_pipeline_variant: (bp.pipeline && bp.pipeline.variant) ? String(bp.pipeline.variant).slice(0, 50) : null,
    pipelinesync_consent: 'true'
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
  const vertical = meta.verticalLabel || fields?.industry || 'Blueprint';
  const dealname = `${first} — ${vertical} Blueprint — ${dateStr}`;
  const amount = fields && fields.typical_deal_size != null ? String(fields.typical_deal_size) : null;
  const closedate = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString();
  // Deal description: summary + kb refs + voice meta (never raw audio)
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
    closedate,
    dealstage: undefined, // let HubSpot use default pipeline stage
    pipeline: undefined,
    hs_deal_stage_probability: undefined
  };
  // Custom deal props if they exist
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
  // Remove undefined
  for (const k of Object.keys(props)) if (props[k] === undefined) delete props[k];
  return props;
}

async function createContact(props, cfg, fetchImpl) {
  const data = await hubspotFetch('/crm/v3/objects/contacts', {
    token: cfg.token, baseUrl: cfg.baseUrl, method: 'POST', body: { properties: props }, fetchImpl
  });
  return data;
}

async function updateContact(contactId, props, cfg, fetchImpl) {
  const data = await hubspotFetch('/crm/v3/objects/contacts/' + encodeURIComponent(contactId), {
    token: cfg.token, baseUrl: cfg.baseUrl, method: 'PATCH', body: { properties: props }, fetchImpl
  });
  return data;
}

async function createDeal(props, cfg, fetchImpl) {
  const data = await hubspotFetch('/crm/v3/objects/deals', {
    token: cfg.token, baseUrl: cfg.baseUrl, method: 'POST', body: { properties: props }, fetchImpl
  });
  return data;
}

async function associateDealToContact(dealId, contactId, cfg, fetchImpl) {
  // Try v4 first (recommended), fall back to v3
  const v4Body = [{ associationCategory: 'HUBSPOT_DEFINED', associationTypeId: 3 }]; // 3 = Deal to Contact
  try {
    await hubspotFetch(`/crm/v4/objects/deals/${encodeURIComponent(dealId)}/associations/contacts/${encodeURIComponent(contactId)}`, {
      token: cfg.token, baseUrl: cfg.baseUrl, method: 'PUT', body: v4Body, fetchImpl
    });
    return true;
  } catch (e) {
    if (e.status === 404) {
      // Fallback: v3 legacy PUT
      try {
        await hubspotFetch(`/crm/v3/objects/deals/${encodeURIComponent(dealId)}/associations/contacts/${encodeURIComponent(contactId)}/3`, {
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

async function createNoteForContact(contactId, dealId, fields, blueprint, voiceCall, cfg, fetchImpl) {
  // Note is best-effort; skip if contactId missing
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
    `PDF: ${bp.meta ? 'PipelineSync_Blueprint_' + (bp.meta.verticalLabel || '').replace(/\s+/g,'') + '_' + new Date().toISOString().slice(0,10) + '.pdf' : ''}`,
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
      // Associate note -> contact (201 = Note to Contact) and note -> deal (214 = Note to Deal)
      try {
        await hubspotFetch(`/crm/v4/objects/notes/${encodeURIComponent(noteId)}/associations/contacts/${encodeURIComponent(contactId)}`, {
          token: cfg.token, baseUrl: cfg.baseUrl, method: 'PUT', body: [{ associationCategory: 'HUBSPOT_DEFINED', associationTypeId: 201 }], fetchImpl
        });
      } catch (e) { console.warn('[hubspot] note->contact association failed:', e.message); }
      if (dealId) {
        try {
          await hubspotFetch(`/crm/v4/objects/notes/${encodeURIComponent(noteId)}/associations/deals/${encodeURIComponent(dealId)}`, {
            token: cfg.token, baseUrl: cfg.baseUrl, method: 'PUT', body: [{ associationCategory: 'HUBSPOT_DEFINED', associationTypeId: 214 }], fetchImpl
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

async function pushLead({ email, name, fields, blueprint, voiceCall, env, fetchImpl }) {
  const cfg = hubspotConfig(env);
  if (!cfg) return { enabled: false, contactId: null, dealId: null, mocked: true };

  const normalizedEmail = String(email || '').trim().toLowerCase();
  if (!normalizedEmail || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(normalizedEmail)) {
    throw new Error('Invalid email for HubSpot push');
  }

  let contactId = null;
  let contact = null;
  let createdContact = false;

  // 1. Search existing contact
  try {
    contact = await searchContactByEmail(normalizedEmail, cfg, fetchImpl);
    if (contact && contact.id) contactId = contact.id;
  } catch (e) {
    console.warn('[hubspot] contact search failed:', e.message);
  }

  // 2. Upsert contact
  const fullProps = buildContactProperties(normalizedEmail, name, fields, blueprint);
  const fallbackProps = (() => {
    const { firstname, lastname } = splitName(name);
    return { email: normalizedEmail, firstname, lastname, lifecyclestage: 'lead' };
  })();

  try {
    if (contactId) {
      try {
        const updated = await updateContact(contactId, fullProps, cfg, fetchImpl);
        contact = updated;
        contactId = updated.id || contactId;
      } catch (e) {
        // If custom props cause 400, retry with fallback
        if (e.status === 400 && /property/i.test(e.message)) {
          console.warn('[hubspot] retrying contact update with fallback props');
          const updated = await updateContact(contactId, fallbackProps, cfg, fetchImpl);
          contact = updated;
          contactId = updated.id || contactId;
        } else throw e;
      }
    } else {
      try {
        const created = await createContact(fullProps, cfg, fetchImpl);
        contact = created;
        contactId = created.id;
        createdContact = true;
      } catch (e) {
        if (e.status === 400 && /property/i.test(e.message)) {
          console.warn('[hubspot] retrying contact create with fallback props');
          const created = await createContact(fallbackProps, cfg, fetchImpl);
          contact = created;
          contactId = created.id;
          createdContact = true;
        } else if (e.status === 409 || /already exists/i.test(e.message)) {
          // Race: contact was created between search and create — search again
          console.warn('[hubspot] contact already exists, re-searching');
          const again = await searchContactByEmail(normalizedEmail, cfg, fetchImpl);
          if (again && again.id) {
            contactId = again.id;
            contact = again;
            try {
              const updated = await updateContact(contactId, fullProps, cfg, fetchImpl);
              contact = updated;
            } catch (e2) {
              if (e2.status === 400 && /property/i.test(e2.message)) {
                const updated = await updateContact(contactId, fallbackProps, cfg, fetchImpl);
                contact = updated;
              }
            }
          } else throw e;
        } else throw e;
      }
    }
  } catch (e) {
    console.error('[hubspot] contact upsert failed:', e.message);
    // Return partial so deal creation can still be attempted? No contactId => no deal association
    // But we still want to know contact failed
    return { enabled: true, contactId, error: e.message, contact, mocked: false };
  }

  // 3. Create deal
  let dealId = null;
  let deal = null;
  try {
    const dealProps = buildDealProperties(normalizedEmail, name, fields, blueprint);
    // If custom deal props cause error, retry with minimal
    try {
      deal = await createDeal(dealProps, cfg, fetchImpl);
      dealId = deal && deal.id;
    } catch (e) {
      if (e.status === 400 && /property/i.test(e.message)) {
        console.warn('[hubspot] retrying deal create with minimal props');
        const minimal = { dealname: dealProps.dealname, description: dealProps.description, closedate: dealProps.closedate };
        if (dealProps.amount) minimal.amount = dealProps.amount;
        deal = await createDeal(minimal, cfg, fetchImpl);
        dealId = deal && deal.id;
      } else throw e;
    }
    if (dealId && contactId) {
      await associateDealToContact(dealId, contactId, cfg, fetchImpl);
    }
  } catch (e) {
    console.error('[hubspot] deal creation failed:', e.message);
    // Don't throw — contact was already created, so return partial success
    return { enabled: true, contactId, dealId: null, dealError: e.message, contact, deal, mocked: false, createdContact };
  }

  // 4. Note (best effort)
  try {
    await createNoteForContact(contactId, dealId, fields, blueprint, voiceCall, cfg, fetchImpl);
  } catch (e) {
    console.warn('[hubspot] note step failed:', e.message);
  }

  console.log(`[hubspot] lead push: contact=${contactId} deal=${dealId || 'none'} email=${normalizedEmail} createdContact=${createdContact}`);
  return { enabled: true, contactId, dealId, contact, deal, mocked: false, createdContact };
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
  pushLead
};
