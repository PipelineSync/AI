'use strict';

const assert = require('assert');
const leads = require('../lib/supabase-leads');

const owner = '11111111-1111-4111-8111-111111111111';
const leadId = '22222222-2222-4222-8222-222222222222';
const env = {
  SUPABASE_URL: 'https://example.supabase.co',
  SUPABASE_SECRET_KEY: 'server-secret',
  PIPELINESYNC_WORKSPACE_OWNER_ID: owner
};

function response(status, body) {
  return { ok: status >= 200 && status < 300, status, text: async () => body == null ? '' : JSON.stringify(body) };
}

(async () => {
  assert.strictEqual(leads.isEnabled({}), false, 'empty local environment disables persistence');
  assert.throws(() => leads.config({ SUPABASE_URL: env.SUPABASE_URL }), /needs SUPABASE/, 'partial configuration fails closed');

  const calls = [];
  const fetchImpl = async (url, opts) => {
    calls.push({ url, opts, body: opts.body ? JSON.parse(opts.body) : null });
    if (opts.method === 'GET') return response(200, []);
    return response(201, [{ id: leadId, user_id: owner, name: 'Maria', email: 'maria@example.com', status: 'new' }]);
  };
  const lead = await leads.createLead('Maria', ' MARIA@EXAMPLE.COM ', { env, fetchImpl });
  assert.strictEqual(lead.id, leadId);
  assert.strictEqual(calls[1].body.email_normalized, 'maria@example.com');
  assert.strictEqual(calls[1].opts.headers.authorization, 'Bearer server-secret');
  assert(!JSON.stringify(require('fs').readFileSync(require('path').join(__dirname, '..', 'public', 'app.js'), 'utf8')).includes('SUPABASE_SECRET_KEY'));

  calls.length = 0;
  const existingFetch = async (url, opts) => {
    calls.push({ url, opts, body: opts.body ? JSON.parse(opts.body) : null });
    if (opts.method === 'GET') return response(200, [{ id: leadId, status: 'blueprint_generated' }]);
    return response(200, [{ id: leadId, status: 'blueprint_generated' }]);
  };
  const returning = await leads.createLead('Maria Updated', 'maria@example.com', { env, fetchImpl: existingFetch });
  assert.strictEqual(returning.status, 'blueprint_generated');
  assert.strictEqual(calls[1].opts.method, 'PATCH');
  assert.strictEqual(calls[1].body.status, undefined, 'returning signup does not reset funnel status');

  calls.length = 0;
  await leads.updateLead(leadId, { email: 'NEW@EXAMPLE.COM', status: 'discovery_started' }, { env, fetchImpl: existingFetch });
  assert.strictEqual(calls[0].body.email_normalized, 'new@example.com');

  console.log('SUPABASE LEAD STORAGE CHECKS PASSED');
})().catch(err => { console.error(err); process.exit(1); });
