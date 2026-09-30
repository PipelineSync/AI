'use strict';
/*
 * One-time HubSpot property setup.
 *
 * Creates the pipelinesync_* custom properties on contacts and deals.
 * Run with: npm run hubspot:setup
 * Or: node scripts/hubspot-setup.js
 *
 * Requires HUBSPOT_ACCESS_TOKEN (or HUBSPOT_API_KEY / HUBSPOT_TOKEN) in env.
 * Reads .env if present? We use process.env only — set it in shell or Netlify env.
 *
 * This replaces the previous in-request auto-creation (ensureCustomPropertiesOnce)
 * that ran inside upsertContact. Now property creation is explicit and out of the
 * hot path. The request path still has a fallback: when a 400 names missing properties
 * and HUBSPOT_AUTO_CREATE_PROPS=true, it will create them, but the setup script is
 * the recommended way.
 */

const path = require('path');
const hubspot = require('../lib/hubspot');

async function main() {
  const env = process.env;
  const cfg = hubspot.hubspotConfig(env);
  if (!cfg) {
    console.error('Missing HUBSPOT_ACCESS_TOKEN (or HUBSPOT_API_KEY). Set it in env and try again.');
    process.exit(1);
  }
  console.log('HubSpot property setup starting...');
  console.log('Using baseUrl:', cfg.baseUrl);
  console.log('Contact custom properties:', hubspot.CONTACT_CUSTOM_PROPERTIES.length);
  console.log('Deal custom properties:', hubspot.DEAL_CUSTOM_PROPERTIES.length);

  let created = 0;
  let existed = 0;
  let failed = 0;

  // We call createProperty via hubspot's internal but we don't have it exported,
  // so we replicate logic using hubspotFetch-like call via hubspot module's createProperty?
  // The lib exports CONTACT_CUSTOM_PROPERTIES and DEAL_CUSTOM_PROPERTIES and hubspotConfig,
  // but not createProperty. We'll use hubspotFetch indirectly by calling the same endpoint.
  // For simplicity, we directly use fetch with timeout handling from hubspot lib? We'll use
  // a small helper that uses global fetch and respects HUBSPOT_TIMEOUT_MS.

  const fetchImpl = globalThis.fetch;
  if (typeof fetchImpl !== 'function') {
    console.error('No fetch available (Node 18+ required).');
    process.exit(1);
  }

  async function createProp(objectType, def) {
    // Use hubspot's internal createProperty logic: POST /crm/v3/properties/{objectType}
    const url = cfg.baseUrl + '/crm/v3/properties/' + objectType;
    const body = {
      name: def.name,
      label: def.label || def.name,
      type: def.type || 'string',
      fieldType: def.fieldType || 'text',
      groupName: def.groupName || (objectType === 'deals' ? 'dealinformation' : 'contactinformation'),
      description: def.description || 'Created by Nova PipelineSync AI',
      hasUniqueValue: false
    };
    const timeoutMs = parseInt(env.HUBSPOT_TIMEOUT_MS || '4000', 10) || 4000;
    const controller = typeof AbortController !== 'undefined' ? new AbortController() : null;
    let timeoutId = null;
    try {
      const opts = {
        method: 'POST',
        headers: {
          Authorization: 'Bearer ' + cfg.token,
          'Content-Type': 'application/json',
          Accept: 'application/json'
        },
        body: JSON.stringify(body)
      };
      if (controller) {
        opts.signal = controller.signal;
        timeoutId = setTimeout(() => controller.abort(), timeoutMs);
      }
      const res = await fetchImpl(url, opts);
      if (timeoutId) clearTimeout(timeoutId);
      const text = await res.text();
      let data = null;
      try { data = text ? JSON.parse(text) : null; } catch (e) { data = text; }
      if (res.ok) {
        console.log(`  ✓ Created ${objectType}.${def.name}`);
        created++;
        return true;
      }
      const msg = data && data.message ? data.message : text;
      if (res.status === 409 || /already exists/i.test(msg || '')) {
        console.log(`  • Exists ${objectType}.${def.name}`);
        existed++;
        return true;
      }
      console.warn(`  ✗ Failed ${objectType}.${def.name}: HTTP ${res.status} ${msg}`);
      failed++;
      return false;
    } catch (e) {
      if (timeoutId) clearTimeout(timeoutId);
      if (e && e.name === 'AbortError') {
        console.warn(`  ✗ Timeout ${objectType}.${def.name} after ${timeoutMs}ms`);
      } else {
        console.warn(`  ✗ Error ${objectType}.${def.name}: ${e.message}`);
      }
      failed++;
      return false;
    }
  }

  console.log('\nContacts:');
  for (const def of hubspot.CONTACT_CUSTOM_PROPERTIES) {
    await createProp('contacts', def);
  }
  console.log('\nDeals:');
  for (const def of hubspot.DEAL_CUSTOM_PROPERTIES) {
    await createProp('deals', def);
  }

  console.log('\nDone. Created:', created, 'Existed:', existed, 'Failed:', failed);
  if (failed > 0) {
    console.log('\nSome properties failed. Check token scopes: crm.schemas.contacts.write and crm.schemas.deals.write required.');
    process.exit(1);
  }
  console.log('\nAll custom properties are present. You can now unset HUBSPOT_AUTO_CREATE_PROPS (or leave it false).');
}

main().catch(e => {
  console.error('Setup failed:', e);
  process.exit(1);
});
