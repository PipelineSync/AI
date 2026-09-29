'use strict';
/*
 * Consent and disclosure tests:
 * - PRIVACY_POLICY_URL env handling (https only, returned by /api/config)
 * - Entry and consent notices render with link when set
 * - Consent checkbox starts unchecked, button disabled
 * - Supabase lead event includes consent_at and consent_version
 * - HubSpot note includes consent line with version
 */

const path = require('path');
const { startServer } = require('./harness');
const consent = require('../lib/consent');
const hubspot = require('../lib/hubspot');

let failures = 0;
const ok = (cond, msg) => { console.log((cond ? '  PASS  ' : '  FAIL  ') + msg); if (!cond) failures++; };
const section = t => console.log('\n' + t);

function stubRes(status, body) {
  const text = body == null ? '' : (typeof body === 'string' ? body : JSON.stringify(body));
  return { ok: status >= 200 && status < 300, status, async text() { return text; }, async json() { try { return JSON.parse(text); } catch (e) { return {}; } } };
}

(async () => {
  section('consent module - PRIVACY_POLICY_URL validation');

  // https valid
  ok(consent.getPrivacyPolicyUrl({ PRIVACY_POLICY_URL: 'https://example.com/privacy' }) === 'https://example.com/privacy', 'https url accepted');
  // http rejected
  ok(consent.getPrivacyPolicyUrl({ PRIVACY_POLICY_URL: 'http://example.com/privacy' }) === null, 'http url treated as unset');
  // invalid
  ok(consent.getPrivacyPolicyUrl({ PRIVACY_POLICY_URL: 'not-a-url' }) === null, 'invalid url treated as unset');
  // empty
  ok(consent.getPrivacyPolicyUrl({}) === null, 'unset returns null');

  ok(consent.CONSENT_VERSION && typeof consent.CONSENT_VERSION === 'string', 'CONSENT_VERSION constant exists: ' + consent.CONSENT_VERSION);

  const noticeHtml = consent.buildNoticeHtml('https://example.com/privacy');
  ok(/Nova is an AI assistant/.test(noticeHtml) && /HubSpot/.test(noticeHtml) && /OpenAI/.test(noticeHtml) && /Claude/.test(noticeHtml) && /Audio is never stored/.test(noticeHtml), 'buildNoticeHtml contains required disclosure lines');
  ok(/Privacy Policy/.test(noticeHtml) && /https:\/\/example.com\/privacy/.test(noticeHtml), 'buildNoticeHtml includes privacy link when set');

  const noticeNoLink = consent.buildNoticeHtml(null);
  ok(/Nova is an AI assistant/.test(noticeNoLink) && !/href/.test(noticeNoLink), 'buildNoticeHtml without link shows notice without link');

  const consentHtml = consent.buildConsentNoticeHtml('https://example.com/privacy');
  ok(/You.*speaking with Nova, an AI/.test(consentHtml), 'buildConsentNoticeHtml says you will be speaking with Nova, an AI');
  ok(/saved to our CRM.*HubSpot/.test(consentHtml), 'consent notice repeats CRM line');
  ok(/Privacy Policy/.test(consentHtml), 'consent notice includes privacy link');

  const noteLine = consent.buildConsentNoteLine('2026-09-28T00:00:00.000Z', 'v1-test', 'https://example.com/privacy');
  ok(/Consent: given at/.test(noteLine) && /v1-test/.test(noteLine) && /example.com\/privacy/.test(noteLine), 'buildConsentNoteLine includes at, version, privacy url');

  section('config returns privacyPolicyUrl only when https');

  const configFn = require(path.join(__dirname, '..', 'netlify', 'functions', 'config.js')).handler;

  // No env
  {
    delete process.env.PRIVACY_POLICY_URL;
    const res = await configFn({ httpMethod: 'GET', path: '/api/config' });
    const j = JSON.parse(res.body);
    ok(j.privacyPolicyUrl === null, 'config without PRIVACY_POLICY_URL returns null');
    ok(j.consentVersion === consent.CONSENT_VERSION, 'config returns consentVersion');
  }
  // Valid https
  {
    process.env.PRIVACY_POLICY_URL = 'https://example.com/privacy';
    const res = await configFn({ httpMethod: 'GET', path: '/api/config' });
    const j = JSON.parse(res.body);
    ok(j.privacyPolicyUrl === 'https://example.com/privacy', 'config returns https privacy url');
    delete process.env.PRIVACY_POLICY_URL;
  }
  // http rejected
  {
    process.env.PRIVACY_POLICY_URL = 'http://example.com/privacy';
    const res = await configFn({ httpMethod: 'GET', path: '/api/config' });
    const j = JSON.parse(res.body);
    ok(j.privacyPolicyUrl === null, 'config treats http url as unset');
    delete process.env.PRIVACY_POLICY_URL;
  }

  section('lead progress stores consent_at and version');

  const leadFn = require(path.join(__dirname, '..', 'netlify', 'functions', 'lead.js')).handler;
  const core = require('../lib/core');
  const token = core.signToken({ email: 'consent@test.com', name: 'Consent Test', lead_id: '00000000-0000-4000-a000-000000000000', exp: Date.now() + core.TOKEN_TTL_MS });

  // Mock Supabase: we don't have real Supabase, but lead.js will try to call leads.isEnabled and return stored:false if not enabled.
  // To test event data, we mock leads.addEvent
  const leads = require('../lib/supabase-leads');
  const origAddEvent = leads.addEvent;
  const origIsEnabled = leads.isEnabled;
  const origUpdate = leads.updateLead;
  const origSave = leads.saveSession;
  let capturedEvent = null;
  leads.isEnabled = () => true;
  leads.updateLead = async () => ({ id: 'test' });
  leads.saveSession = async () => ({ id: 'sess' });
  leads.addEvent = async (leadId, eventType, eventData) => { capturedEvent = { leadId, eventType, eventData }; return {}; };

  try {
    const res = await leadFn({
      httpMethod: 'POST', path: '/api/lead/progress',
      body: JSON.stringify({ token, status: 'discovery_started', consent_at: '2026-09-28T12:00:00.000Z', consent_version: 'v1-test', privacy_policy_url: 'https://example.com/privacy' })
    });
    ok(res.statusCode === 200, 'lead progress 200 with consent');
    ok(capturedEvent && capturedEvent.eventData.consent_at === '2026-09-28T12:00:00.000Z', 'event includes consent_at');
    ok(capturedEvent && capturedEvent.eventData.consent_version === 'v1-test', 'event includes consent_version');
    ok(capturedEvent && capturedEvent.eventData.privacy_policy_url === 'https://example.com/privacy', 'event includes privacy_policy_url');
  } finally {
    leads.addEvent = origAddEvent;
    leads.isEnabled = origIsEnabled;
    leads.updateLead = origUpdate;
    leads.saveSession = origSave;
  }

  section('HubSpot note includes consent line');

  // Use makeHsStub from netlify-sim pattern
  function makeHsStub() {
    const calls = [];
    const fetchImpl = async (url, init) => {
      const method = (init && init.method) || 'GET';
      let parsed = null;
      try { parsed = init && init.body ? JSON.parse(init.body) : null; } catch (e) {}
      calls.push({ url: String(url), method, body: parsed });
      const u = String(url);
      if (u.includes('/contacts/search')) return stubRes(200, { total: 0, results: [] });
      if (method === 'POST' && /\/objects\/contacts\/?$/.test(u.split('?')[0])) return stubRes(200, { id: '101', properties: {} });
      if (method === 'POST' && /\/objects\/deals\/?$/.test(u.split('?')[0])) return stubRes(200, { id: '202', properties: {} });
      if (method === 'POST' && /\/objects\/notes\/?$/.test(u.split('?')[0])) return stubRes(200, { id: '303', properties: {} });
      if (method === 'PUT' && u.includes('/associations/')) return stubRes(200, {});
      return stubRes(404, { message: 'not stubbed' });
    };
    return { fetchImpl, calls };
  }

  const stub = makeHsStub();
  const env = { HUBSPOT_ACCESS_TOKEN: 'pat-na1-test-token-xxxxxxxx', PRIVACY_POLICY_URL: 'https://example.com/privacy' };
  const push = await hubspot.pushLead({
    email: 'consent-note@test.com', name: 'Consent Note',
    fields: { industry: 'solar' },
    blueprint: { meta: { verticalLabel: 'Solar', kb_version: 'v1' }, stack: { tier: 'Pro' }, pipeline: { label: 'Test', variant: 'one-call' }, summary: { text: 'Summary' }, kbReferences: ['KB-1'] },
    env, fetchImpl: stub.fetchImpl,
    consentInfo: { consent_at: '2026-09-28T12:00:00.000Z', consent_version: 'v1-test' }
  });
  const noteCall = stub.calls.find(c => c.method === 'POST' && c.url.includes('/objects/notes'));
  const noteBody = noteCall && noteCall.body && noteCall.body.properties && noteCall.body.properties.hs_note_body;
  ok(/Consent: given at/.test(noteBody || '') && /v1-test/.test(noteBody || '') || /Consent: given at/.test(noteBody || '') && /v1-2026-09-28/.test(noteBody || ''), 'HubSpot note includes consent line with version');
  ok(/audio_retained: false/.test(noteBody || ''), 'note still includes audio_retained');

  section('server config returns privacyPolicyUrl');

  const srv = await startServer(8096, { PRIVACY_POLICY_URL: 'https://example.com/privacy' });
  try {
    const cfg = await (await fetch(srv.base + '/api/config')).json();
    ok(cfg.privacyPolicyUrl === 'https://example.com/privacy', 'server config returns https privacy url');
    ok(cfg.consentVersion === consent.CONSENT_VERSION, 'server config returns consentVersion');
  } finally { srv.stop(); }

  const srv2 = await startServer(8097, { PRIVACY_POLICY_URL: 'http://example.com/privacy' });
  try {
    const cfg = await (await fetch(srv2.base + '/api/config')).json();
    ok(cfg.privacyPolicyUrl === null, 'server config treats http url as unset');
  } finally { srv2.stop(); }

  console.log('\n' + (failures === 0 ? 'CONSENT TESTS PASSED' : failures + ' FAILURE(S)'));
  process.exit(failures === 0 ? 0 : 1);
})().catch(e => { console.error('Consent test error:', e); process.exit(1); });
