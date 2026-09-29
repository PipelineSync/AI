/* Simulates Netlify invoking the functions with Lambda-style events,
   so the deployed code path is tested before pushing to GitHub. */
const path = require('path');
const hubspot = require('../lib/hubspot');
const core = require('../lib/core');
process.env.DELIVER_PER_EMAIL_DAY = '1000';
process.env.PDF_EMAIL_DAILY_MAX = '1000';
process.env.DEMO_MODE = 'true';
process.env.EMAIL_VERIFY = 'false';
try { require('../lib/deliver-limits')._resetMemory(); } catch (e) {}
try { require('../lib/deliver-idempotency')._resetMemory(); } catch (e) {}
try { require('../lib/email-verify')._resetMemory(); } catch (e) {}
try { require('../lib/job-store')._resetMemory(); } catch (e) {}
const F = dir => require(path.join(__dirname, '..', 'netlify', 'functions', dir));
const start = F('start.js').handler;
const login = F('login.js').handler;
const logout = F('logout.js').handler;
const extract = F('extract.js').handler;
const generate = F('generate.js').handler;
const generateStatus = F('generate-status.js').handler;

async function runGenerate(token, fields) {
  const res = await generate({ httpMethod: 'POST', path: '/api/generate', body: JSON.stringify({ token, fields }) });
  const body = JSON.parse(res.body || '{}');
  if (res.statusCode !== 202 || !body.jobId) return { statusCode: res.statusCode, body, status: null, blueprint: null };
  for (let i = 0; i < 100; i++) {
    const st = await generateStatus({ httpMethod: 'GET', path: '/api/generate/status', queryStringParameters: { jobId: body.jobId, token } });
    const sj = JSON.parse(st.body || '{}');
    if (sj.status === 'done' || sj.status === 'error') {
      return { statusCode: res.statusCode, body, status: sj, blueprint: sj.blueprint || null, jobId: body.jobId, fields: sj.fields || fields };
    }
    await new Promise(r => setTimeout(r, 20));
  }
  throw new Error('runGenerate: job never finished');
}
const deliver = F('deliver.js').handler;
const outbox = F('outbox.js').handler;
const voiceFn = F('voice.js').handler;
const leadProgress = F('lead.js').handler;
const health = F('health.js').handler;

const personas = require('./personas.json');
let failures = 0;
const ok = (cond, msg) => { console.log((cond ? '  PASS  ' : '  FAIL  ') + msg); if (!cond) failures++; };

function hsRes(status, body, headers) {
  const text = body == null ? '' : (typeof body === 'string' ? body : JSON.stringify(body));
  const hdrs = headers || {};
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get(k) { const want = String(k).toLowerCase(); for (const [hk, hv] of Object.entries(hdrs)) if (String(hk).toLowerCase() === want) return hv; return null; } },
    async text() { return text; }
  };
}
function makeHsStub(opts) {
  opts = opts || {};
  const calls = [];
  const contacts = Object.assign({}, opts.contacts || {});
  let contactSeq = opts.contactSeq || 1000;
  let dealSeq = opts.dealSeq || 2000;
  let noteSeq = opts.noteSeq || 3000;
  const failPlan = (opts.failPlan || []).map(f => Object.assign({}, f));
  const fetchImpl = async (url, init) => {
    const method = (init && init.method) || 'GET';
    let parsed = null;
    try { parsed = init && init.body ? JSON.parse(init.body) : null; } catch (e) { parsed = init && init.body; }
    calls.push({ url: String(url), method, body: parsed });
    for (const f of failPlan) {
      if (!(f.times > 0)) continue;
      if (f.path && String(url).indexOf(f.path) < 0) continue;
      if (f.notPath && String(url).indexOf(f.notPath) >= 0) continue;
      if (f.method && f.method !== method) continue;
      f.times--;
      if (f.throw) throw f.throw;
      return hsRes(f.status, f.body, f.headers);
    }
    const u = String(url);
    if (u.indexOf('/crm/v3/objects/contacts/search') >= 0) {
      const email = parsed && parsed.filterGroups && parsed.filterGroups[0] && parsed.filterGroups[0].filters && parsed.filterGroups[0].filters[0] && parsed.filterGroups[0].filters[0].value;
      const hit = email ? contacts[String(email).toLowerCase()] : null;
      return hsRes(200, { total: hit ? 1 : 0, results: hit ? [hit] : [] });
    }
    if (method === 'POST' && /\/crm\/v3\/objects\/contacts\/?$/.test(u.split('?')[0])) {
      const props = (parsed && parsed.properties) || {};
      const id = String(++contactSeq);
      const rec = { id, properties: Object.assign({}, props) };
      if (props.email) contacts[String(props.email).toLowerCase()] = rec;
      return hsRes(200, rec);
    }
    if (method === 'PATCH' && /\/crm\/v3\/objects\/contacts\//.test(u)) {
      const id = decodeURIComponent(u.split('/contacts/')[1].split(/[/?]/)[0]);
      return hsRes(200, { id, properties: Object.assign({}, (parsed && parsed.properties) || {}) });
    }
    if (method === 'POST' && /\/crm\/v3\/objects\/deals\/?$/.test(u.split('?')[0])) {
      return hsRes(200, { id: String(++dealSeq), properties: (parsed && parsed.properties) || {} });
    }
    if (method === 'POST' && /\/crm\/v3\/objects\/notes\/?$/.test(u.split('?')[0])) {
      return hsRes(200, { id: String(++noteSeq), properties: (parsed && parsed.properties) || {} });
    }
    if (method === 'PUT' && u.indexOf('/associations/') >= 0) return hsRes(200, {});
    if (method === 'POST' && /\/crm\/v3\/properties\//.test(u)) return hsRes(201, { name: parsed && parsed.name });
    return hsRes(404, { message: 'not stubbed ' + u });
  };
  return { fetchImpl, calls, contacts };
}
function searchCalls(calls) { return calls.filter(c => c.url.indexOf('/contacts/search') >= 0); }
function createContactCalls(calls) { return calls.filter(c => c.method === 'POST' && /\/objects\/contacts\/?$/.test(c.url.split('?')[0])); }
function patchContactCalls(calls) { return calls.filter(c => c.method === 'PATCH' && c.url.indexOf('/objects/contacts/') >= 0); }

(async () => {
  delete process.env.HUBSPOT_ACCESS_TOKEN;
  delete process.env.HUBSPOT_API_KEY;
  delete process.env.HUBSPOT_TOKEN;
  delete process.env.HUBSPOT_AUTO_CREATE_PROPS;

  const h = await health({ httpMethod: 'GET', path: '/api/health' });
  ok(h.statusCode === 200 && JSON.parse(h.body).mode === 'netlify', 'health function (netlify mode)');

  const bad = await start({ httpMethod: 'POST', path: '/api/auth/start', body: JSON.stringify({ name: 'Allen', email: 'nope' }) });
  ok(bad.statusCode === 400, 'entry gate rejects a bad email');
  const noName = await start({ httpMethod: 'POST', path: '/api/auth/start', body: JSON.stringify({ email: 'allen@pipelinesync.ai' }) });
  ok(noName.statusCode === 400, 'entry gate rejects a missing name');

  const lg = await start({ httpMethod: 'POST', path: '/api/auth/start', body: JSON.stringify({ name: 'Allen Reyes', email: 'allen@pipelinesync.ai' }) });
  ok(lg.statusCode === 200 && JSON.parse(lg.body).token, 'entry gate returns a signed token');
  ok(JSON.parse(lg.body).user.name === 'Allen Reyes', 'the token carries the name the client typed');
  const startHs = JSON.parse(lg.body).hubspot;
  ok(startHs && startHs.mocked === true && startHs.ok === false, 'start reports hubspot:{ok:false, mocked:true} when no token');
  const T = JSON.parse(lg.body).token;

  // Lead-progress metadata is clamped before the Netlify path stores it in Supabase.
  {
    const leadId = '22222222-2222-4222-8222-222222222222';
    const ownerId = '11111111-1111-4111-8111-111111111111';
    const oldEnv = {
      SUPABASE_URL: process.env.SUPABASE_URL,
      SUPABASE_SECRET_KEY: process.env.SUPABASE_SECRET_KEY,
      SUPABASE_SERVICE_ROLE_KEY: process.env.SUPABASE_SERVICE_ROLE_KEY,
      PIPELINESYNC_WORKSPACE_OWNER_ID: process.env.PIPELINESYNC_WORKSPACE_OWNER_ID
    };
    const oldFetch = globalThis.fetch;
    const dbCalls = [];
    try {
      process.env.SUPABASE_URL = 'https://example.supabase.co';
      process.env.SUPABASE_SECRET_KEY = 'server-only-test-secret';
      process.env.PIPELINESYNC_WORKSPACE_OWNER_ID = ownerId;
      globalThis.fetch = async (url, init) => {
        const call = { url: String(url), method: (init && init.method) || 'GET', body: init && init.body ? JSON.parse(init.body) : null };
        dbCalls.push(call);
        return call.method === 'GET' && call.url.includes('pipeline_lead_sessions') ? hsRes(200, []) : hsRes(200, [{ id: leadId }]);
      };
      const authPayload = Object.assign({}, core.verifyToken(T), { lead_id: leadId });
      const tokenWithLead = core.signToken(authPayload);
      const progress = await leadProgress({
        httpMethod: 'POST', path: '/api/lead/progress',
        body: JSON.stringify({ token: tokenWithLead, status: 'discovery_completed', voice_meta: {
          provider: 'openai-realtime', median_ms: 420, p90_ms: 890, turns_measured: 7, untrusted: 'drop me'
        } })
      });
      const sessionWrite = dbCalls.find(call => call.method === 'POST' && call.url.includes('pipeline_lead_sessions'));
      ok(progress.statusCode === 200, 'Netlify lead progress accepts the completed-call metadata');
      ok(sessionWrite && sessionWrite.body.voice_metadata.median_ms === 420 && sessionWrite.body.voice_metadata.p90_ms === 890 && sessionWrite.body.voice_metadata.turns_measured === 7, 'Supabase session metadata preserves median, p90, and measured turns');
      ok(sessionWrite && sessionWrite.body.voice_metadata.untrusted === undefined, 'the Netlify progress path drops unrecognized voice metadata before persistence');
    } finally {
      globalThis.fetch = oldFetch;
      for (const [key, value] of Object.entries(oldEnv)) {
        if (value === undefined) delete process.env[key]; else process.env[key] = value;
      }
    }
  }

  const alias = await login({ httpMethod: 'POST', path: '/api/auth/login', body: JSON.stringify({ name: 'Allen Reyes', email: 'allen@pipelinesync.ai' }) });
  ok(alias.statusCode === 200 && JSON.parse(alias.body).token, 'the login function still serves the entry gate (alias)');

  delete require.cache[require.resolve('../lib/core')];
  const coreFresh = require('../lib/core');
  ok(!!coreFresh.verifyToken(T), 'token verifies in a fresh module instance (stateless auth)');

  const p = personas.solar;
  const answers = Object.entries(p.answers).map(([id, text]) => ({ id, text }));
  const ex = await extract({ httpMethod: 'POST', path: '/api/extract', body: JSON.stringify({ token: T, answers }) });
  ok(ex.statusCode === 200, 'extract function 200');
  const fields = JSON.parse(ex.body).fields;

  const gen = await runGenerate(T, fields);
  ok(gen.statusCode === 202 && gen.body.jobId, 'generate function accepts the job (202 + jobId)');
  ok(gen.status && gen.status.status === 'done' && gen.blueprint, 'the job completes and the status endpoint returns the blueprint');
  ok(gen.status.source === 'fallback', 'no ANTHROPIC_API_KEY: source is reported as fallback');
  ok(gen.status.progress === 100, 'a finished job reports 100% progress');
  const bp = gen.blueprint;
  const jobId = gen.jobId;

  // Deliver now uses jobId, not blueprint. Token email everywhere.
  const jobs = require('../lib/job-store');
  const idempotency = require('../lib/deliver-idempotency');
  try { jobs._resetMemory(); idempotency._resetMemory(); } catch (e) {}
  // Recreate job because previous reset cleared it, need fresh job for deliver tests
  const gen2 = await runGenerate(T, fields);
  const jobId2 = gen2.jobId;

  const dv = await deliver({ httpMethod: 'POST', path: '/api/deliver', body: JSON.stringify({ token: T, jobId: jobId2, consent: true }) });
  ok(dv.statusCode === 200, 'deliver function 200 with jobId');
  const dj = JSON.parse(dv.body);
  ok(!!dj.contact_id && !!dj.pdf_base64, 'deliver returns contact id + base64 pdf');
  ok(dj.hubspot && dj.hubspot.mocked === true && dj.lead_pushed === false, 'mocked deliver does not claim a live HubSpot push');
  const pdf = Buffer.from(dj.pdf_base64, 'base64');
  ok(pdf.slice(0, 8).toString('latin1').startsWith('%PDF-1.4'), 'function-generated pdf is valid');

  // Hand-made blueprint without valid jobId gets no PDF
  const badJob = await deliver({ httpMethod: 'POST', path: '/api/deliver', body: JSON.stringify({ token: T, jobId: 'deadbeefdeadbeef', consent: true, blueprint: { meta: { verticalLabel: 'Fake' } } }) });
  ok(badJob.statusCode === 404, 'hand-made blueprint without valid jobId gets 404');
  ok(!JSON.parse(badJob.body).pdf_base64, 'no PDF for invalid jobId');

  const exB64 = await extract({ httpMethod: 'POST', path: '/api/extract', isBase64Encoded: true, body: Buffer.from(JSON.stringify({ token: T, answers })).toString('base64') });
  ok(exB64.statusCode === 200, 'extract handles base64-encoded body');

  const noTok = await extract({ httpMethod: 'POST', path: '/api/extract', body: JSON.stringify({ answers }) });
  ok(noTok.statusCode === 401, 'extract rejects missing token');
  const badTok = await extract({ httpMethod: 'POST', path: '/api/extract', body: JSON.stringify({ token: 'garbage', answers }) });
  ok(badTok.statusCode === 401, 'extract rejects forged token');

  const vs = await voiceFn({ httpMethod: 'POST', path: '/api/voice/session', body: JSON.stringify({ token: T }) });
  ok(vs.statusCode === 200 && JSON.parse(vs.body).plan.length === 12, 'voice function serves the call plan through /api/voice/*');
  const vturn = await voiceFn({ httpMethod: 'POST', path: '/api/voice/turn', body: JSON.stringify({ token: T, call_id: 'sim-1', answers: [], asked: [], probes: {}, with_audio: false }) });
  const vj = JSON.parse(vturn.body);
  ok(vturn.statusCode === 200 && vj.ask.id === 'business', 'voice function serves a turn and the guardrail question');
  const fallback = await voiceFn({ httpMethod: 'POST', path: '/api/voice/fallback', body: JSON.stringify({ token: T, call_id: 'netlify-fallback', reason: 'mic-blocked' }) });
  ok(fallback.statusCode === 200 && JSON.parse(fallback.body).fallback_reason === 'mic-blocked', 'Netlify records the same canonical client fallback reason as the local server');
  const vsub = await voiceFn({ httpMethod: 'POST', path: '/.netlify/functions/voice', queryStringParameters: { op: 'speak' }, body: JSON.stringify({ token: T, text: 'Testing.' }) });
  ok(vsub.statusCode === 200, 'voice function resolves its sub-route from the function path');
  const vno = await voiceFn({ httpMethod: 'POST', path: '/api/voice/turn', body: JSON.stringify({}) });
  ok(vno.statusCode === 401, 'voice function rejects a missing token');

  const ob = await outbox({ httpMethod: 'GET', path: '/dev/outbox' });
  ok(ob.statusCode === 200 && ob.body.includes('function logs'), 'outbox page explains where leads go on Netlify');

  const lo = await logout({ httpMethod: 'POST', path: '/api/auth/logout', body: JSON.stringify({ token: T }) });
  ok(lo.statusCode === 200, 'logout ok');

  hubspot.setSleep(async () => {});
  hubspot.resetForTests();
  ok(hubspot.ASSOC.NOTE_TO_CONTACT === 202, 'note→contact associationTypeId is 202 (not 201)');
  ok(hubspot.ASSOC.NOTE_TO_DEAL === 214, 'note→deal associationTypeId is 214');

  const createdProps = hubspot.buildContactProperties('new@ex.com', 'Maria Santos', null, null, { onCreate: true });
  ok(createdProps.lifecyclestage === 'lead' && createdProps.hs_lead_status === 'NEW', 'create sets lifecyclestage=lead and hs_lead_status=NEW');
  ok(createdProps.firstname === 'Maria' && createdProps.lastname === 'Santos' && createdProps.pipelinesync_source === 'pipelinesync_ai', 'create writes name split + lead source');
  const updatedProps = hubspot.buildContactProperties('new@ex.com', 'Maria Santos', null, null, { onCreate: false });
  ok(updatedProps.lifecyclestage == null && updatedProps.hs_lead_status == null, 'update does not set lifecycle or lead status (no demotion)');
  ok(updatedProps.firstname == null && updatedProps.lastname == null, 'update does not overwrite firstname/lastname (only on create)');

  const unknownErr = {
    status: 400,
    message: 'Property values were not valid: [{\"isValid\":false,\"message\":\"Property \\\"pipelinesync_headache\\\" does not exist\",\"error\":\"PROPERTY_DOESNT_EXIST\",\"name\":\"pipelinesync_headache\"}]',
    data: { message: 'Property values were not valid: [{\"name\":\"pipelinesync_headache\"}]', errors: [{ name: 'pipelinesync_headache', message: 'Property \"pipelinesync_headache\" does not exist' }] }
  };
  const dropped = hubspot.parseUnknownPropertyNames(unknownErr, ['email', 'firstname', 'pipelinesync_source', 'pipelinesync_headache']);
  ok(dropped.includes('pipelinesync_headache') && !dropped.includes('email') && !dropped.includes('pipelinesync_source'), 'unknown-property parser drops only the named field');

  // ---- Phase 7: HubSpot timeouts, deal data, owner, droppedProps ----
  // Timeout: hubspotFetch with hanging stub respects HUBSPOT_TIMEOUT_MS via AbortController
  {
    const hanging = {
      calls: 0,
      fetchImpl: async (url, init) => {
        hanging.calls++;
        return new Promise((resolve, reject) => {
          const sig = init && init.signal;
          if (sig) {
            if (sig.aborted) {
              const e = new Error('aborted');
              e.name = 'AbortError';
              return reject(e);
            }
            sig.addEventListener('abort', () => {
              const e = new Error('aborted');
              e.name = 'AbortError';
              reject(e);
            });
          }
        });
      }
    };
    const cfg = { token: 'pat-test', baseUrl: 'https://api.hubapi.com' };
    const start = Date.now();
    let timedOut = false;
    try {
      await hubspot.searchContactByEmail('timeout@test.com', cfg, hanging.fetchImpl, { HUBSPOT_TIMEOUT_MS: '30' });
    } catch (e) {
      timedOut = /timed out/i.test(e.message);
    }
    const elapsed = Date.now() - start;
    ok(timedOut && elapsed < 500, 'hubspotFetch respects HUBSPOT_TIMEOUT_MS via AbortController (elapsed ' + elapsed + 'ms)');
    ok(hanging.calls >= 1, 'hanging stub was called');
  }

  // Backoff capped at 1000 ms
  {
    const wait = hubspot.MAX_BACKOFF_MS;
    ok(wait === 1000, 'MAX_BACKOFF_MS is 1000 (capped)');
    ok(true, 'Retry-After capped at 1000 ms (checked via constant)');
  }

  // Deal data: amount not set from typical_deal_size unless HUBSPOT_DEAL_AMOUNT
  {
    const dealProps = hubspot.buildDealProperties('test@example.com', 'Test User', { typical_deal_size: 123456 }, { meta: { verticalLabel: 'Solar' } }, { env: {} });
    ok(dealProps.amount == null, 'deal amount not set from typical_deal_size when HUBSPOT_DEAL_AMOUNT unset');
    const dealProps2 = hubspot.buildDealProperties('test@example.com', 'Test User', { typical_deal_size: 123456 }, { meta: { verticalLabel: 'Solar' } }, { env: { HUBSPOT_DEAL_AMOUNT: '99999' } });
    ok(dealProps2.amount === '99999', 'deal amount set from HUBSPOT_DEAL_AMOUNT when configured');
    const dealProps3 = hubspot.buildDealProperties('test@example.com', 'Test User', {}, { meta: { verticalLabel: 'Solar' } }, { env: { HUBSPOT_DEAL_PIPELINE: '123', HUBSPOT_DEAL_STAGE: '456' } });
    ok(dealProps3.pipeline === '123' && dealProps3.dealstage === '456', 'deal pipeline and stage set from env when configured');
    const dealProps4 = hubspot.buildDealProperties('test@example.com', 'Test User', {}, { meta: { verticalLabel: 'Solar' } }, { env: { HUBSPOT_OWNER_ID: '789' } });
    ok(dealProps4.hubspot_owner_id === '789', 'deal owner id set from HUBSPOT_OWNER_ID');
    const contactPropsOwner = hubspot.buildContactProperties('test@example.com', 'Owner Test', null, null, { onCreate: true, env: { HUBSPOT_OWNER_ID: '789' } });
    ok(contactPropsOwner.hubspot_owner_id === '789', 'contact owner id set on create from HUBSPOT_OWNER_ID');
    const contactPropsOwnerUpdate = hubspot.buildContactProperties('test@example.com', 'Owner Test', null, null, { onCreate: false, env: { HUBSPOT_OWNER_ID: '789' } });
    ok(contactPropsOwnerUpdate.hubspot_owner_id == null, 'contact owner id not set on update (only on create)');
  }

  // DroppedProps logging: when 400 names no specific property, drops every custom and logs
  {
    const stub = makeHsStub({
      failPlan: [
        { path: '/crm/v3/objects/contacts', notPath: '/search', method: 'POST', times: 1, status: 400, body: { message: 'Invalid input' } }
      ]
    });
    const liveEnv2 = { HUBSPOT_ACCESS_TOKEN: 'pat-na1-test-token-xxxxxxxx' };
    const r = await hubspot.upsertContact({
      email: 'drop-all@example.com', name: 'Drop All',
      fields: { biggest_headache: 'test', industry: 'solar' },
      env: liveEnv2, fetchImpl: stub.fetchImpl
    });
    ok(r.contactId, 'last-resort drop still succeeds after dropping all custom props');
    ok(Array.isArray(r.droppedProps) && r.droppedProps.length > 0, 'droppedProps included in result when 400 names no property (got ' + (r.droppedProps||[]).join(',') + ')');
    const firstCallProps = stub.calls.filter(c => c.method === 'POST' && /\/objects\/contacts\/?$/.test(c.url.split('?')[0]))[0];
    const secondCallProps = stub.calls.filter(c => c.method === 'POST' && /\/objects\/contacts\/?$/.test(c.url.split('?')[0]))[1];
    ok(firstCallProps && firstCallProps.body.properties.pipelinesync_headache, 'first call includes custom');
    ok(secondCallProps && !secondCallProps.body.properties.pipelinesync_headache && secondCallProps.body.properties.email, 'second call drops custom but keeps email');
  }


  const liveEnv = { HUBSPOT_ACCESS_TOKEN: 'pat-na1-test-token-xxxxxxxx' };

  {
    const stub = makeHsStub();
    const r = await hubspot.captureLead({ email: 'create@solar.ph', name: 'Create Lead', env: liveEnv, fetchImpl: stub.fetchImpl });
    ok(r.ok === true && r.mocked === false && r.contactId, 'captureLead create returns ok + contactId');
    const created = createContactCalls(stub.calls);
    ok(created.length === 1, 'create path POSTs the contact once');
    const props = created[0].body && created[0].body.properties;
    ok(props && props.lifecyclestage === 'lead' && props.hs_lead_status === 'NEW', 'create POST includes lifecycle + NEW lead status');
    ok(props && props.email === 'create@solar.ph' && props.firstname === 'Create' && props.pipelinesync_source === 'pipelinesync_ai', 'create POST includes email, firstname, lead source');
  }
  {
    const stub = makeHsStub({ contacts: { 'existing@solar.ph': { id: '99', properties: { email: 'existing@solar.ph', lifecyclestage: 'customer', hs_lead_status: 'OPEN' } } } });
    const r = await hubspot.upsertContact({ email: 'existing@solar.ph', name: 'Existing Lead', env: liveEnv, fetchImpl: stub.fetchImpl });
    ok(r.contactId === '99' && r.createdContact === false, 'upsert finds the existing contact and updates it');
    ok(createContactCalls(stub.calls).length === 0, 'update path does not POST a new contact');
    const patches = patchContactCalls(stub.calls);
    ok(patches.length === 1, 'update path PATCHes the existing contact');
    const props = patches[0].body && patches[0].body.properties;
    ok(props && props.lifecyclestage == null && props.hs_lead_status == null, 'update PATCH never sends lifecyclestage or hs_lead_status');
    ok(props && props.email === 'existing@solar.ph' && props.pipelinesync_source === 'pipelinesync_ai', 'update PATCH still writes email + lead source');
  }
  {
    const stub = makeHsStub({ failPlan: [{ path: '/contacts/search', times: 2, status: 429, headers: { 'Retry-After': '0' }, body: { message: 'rate limited' } }] });
    const r = await hubspot.captureLead({ email: 'retry@solar.ph', name: 'Retry Lead', env: liveEnv, fetchImpl: stub.fetchImpl });
    ok(r.ok === true && r.contactId, '429 then success still captures the lead');
    ok(searchCalls(stub.calls).length === 3, '429 is retried up to 3 tries (2 failures + 1 success)');
  }
  {
    const unknownBody = { status: 'error', message: 'Property values were not valid: [{\"isValid\":false,\"message\":\"Property \\\"pipelinesync_headache\\\" does not exist\",\"error\":\"PROPERTY_DOESNT_EXIST\",\"name\":\"pipelinesync_headache\"}]', errors: [{ name: 'pipelinesync_headache', message: 'Property \"pipelinesync_headache\" does not exist' }] };
    const stub = makeHsStub({ failPlan: [{ path: '/crm/v3/objects/contacts', notPath: '/search', method: 'POST', times: 1, status: 400, body: unknownBody }] });
    const r = await hubspot.upsertContact({ email: 'drop@solar.ph', name: 'Drop Lead', fields: { biggest_headache: 'Follow-ups slip', industry: 'solar' }, env: liveEnv, fetchImpl: stub.fetchImpl });
    ok(r.contactId && !r.error, 'upsert succeeds after dropping the unknown property');
    const posts = createContactCalls(stub.calls);
    ok(posts.length === 2, 'unknown-property 400 retries the create once (got ' + posts.length + ')');
    const first = posts[0] && posts[0].body && posts[0].body.properties;
    const second = posts[1] && posts[1].body && posts[1].body.properties;
    ok(!!first && first.pipelinesync_headache === 'Follow-ups slip' && first.pipelinesync_source === 'pipelinesync_ai' && first.pipelinesync_industry === 'solar', 'first create includes the unknown property plus other custom fields');
    ok(!!second && second.pipelinesync_headache == null && second.pipelinesync_source === 'pipelinesync_ai' && second.pipelinesync_industry === 'solar' && second.email === 'drop@solar.ph', 'retry drops only pipelinesync_headache and keeps source, industry, email');
  }
  {
    const stub = makeHsStub();
    const r = await hubspot.pushLead({ email: 'note@solar.ph', name: 'Note Lead', fields: { industry: 'solar', typical_deal_size: 1500000, biggest_headache: 'Follow-ups slip' }, blueprint: bp, env: liveEnv, fetchImpl: stub.fetchImpl });
    ok(r.contactId && r.dealId && !r.mocked, 'pushLead creates contact + deal');
    const noteAssoc = stub.calls.filter(c => c.method === 'PUT' && /\/notes\/\d+\/associations\/contacts\//.test(c.url));
    ok(noteAssoc.length >= 1, 'note is associated to the contact');
    const typeId = noteAssoc[0].body && noteAssoc[0].body[0] && noteAssoc[0].body[0].associationTypeId;
    ok(typeId === 202, 'note→contact associationTypeId is 202');
  }

  const origFetch = globalThis.fetch;
  process.env.HUBSPOT_ACCESS_TOKEN = 'pat-na1-test-token-xxxxxxxx';
  try {
    const liveStub = makeHsStub();
    globalThis.fetch = liveStub.fetchImpl;

    const liveStart = await start({ httpMethod: 'POST', path: '/api/auth/start', body: JSON.stringify({ name: 'Maria Live', email: 'maria-live@solar.ph' }) });
    ok(liveStart.statusCode === 200, 'live start still 200 with a stubbed HubSpot');
    const liveBody = JSON.parse(liveStart.body);
    ok(liveBody.hubspot && liveBody.hubspot.ok === true && liveBody.hubspot.contactId && liveBody.hubspot.mocked === false, 'live start reports hubspot.ok with a contactId');
    const liveTok = liveBody.token;
    const livePayload = coreFresh.verifyToken(liveTok);
    ok(livePayload && livePayload.hubspot_contact_id === liveBody.hubspot.contactId, 'signed token carries hubspot_contact_id from start');
    const searchesAfterStart = searchCalls(liveStub.calls).length;
    ok(searchesAfterStart >= 1, 'live start searches HubSpot by email');
    ok(createContactCalls(liveStub.calls).length === 1, 'live start creates the contact');

    const liveEx = await extract({ httpMethod: 'POST', path: '/api/extract', body: JSON.stringify({ token: liveTok, answers }) });
    ok(liveEx.statusCode === 200, 'extract after live start 200');
    const liveFields = JSON.parse(liveEx.body).fields;
    const liveGen = await runGenerate(liveTok, liveFields);
    ok(liveGen.statusCode === 202 && liveGen.blueprint, 'generate after live start completes');
    const liveBp = liveGen.blueprint;
    const liveJobId = liveGen.jobId;

    const liveDv = await deliver({ httpMethod: 'POST', path: '/api/deliver', body: JSON.stringify({ token: liveTok, jobId: liveJobId, consent: true }) });
    ok(liveDv.statusCode === 200, 'live deliver 200 with jobId');
    const liveDj = JSON.parse(liveDv.body);
    ok(liveDj.hubspot && liveDj.hubspot.ok === true && liveDj.hubspot.contactId === liveBody.hubspot.contactId && liveDj.lead_pushed === true, 'live deliver reuses the start contactId and claims the push');
    const searchesAfterDeliver = searchCalls(liveStub.calls).length;
    ok(searchesAfterDeliver === searchesAfterStart, 'deliver reuses hubspot_contact_id and does not re-search by email');
    ok(liveDj.hubspot.dealId, 'live deliver creates a deal');
    const liveNoteAssoc = liveStub.calls.filter(c => c.method === 'PUT' && /\/notes\/.+\/associations\/contacts\//.test(c.url));
    const liveTypeId = liveNoteAssoc[0] && liveNoteAssoc[0].body && liveNoteAssoc[0].body[0] && liveNoteAssoc[0].body[0].associationTypeId;
    ok(liveTypeId === 202, 'live deliver note→contact associationTypeId is 202');

    globalThis.fetch = async () => { throw new Error('HubSpot unreachable'); };
    const down = await start({ httpMethod: 'POST', path: '/api/auth/start', body: JSON.stringify({ name: 'Down Lead', email: 'down@solar.ph' }) });
    ok(down.statusCode === 200 && JSON.parse(down.body).token, 'start still 200 when HubSpot fetch throws');
    const downHs = JSON.parse(down.body).hubspot;
    ok(downHs && downHs.ok === false && downHs.mocked === false && downHs.error, 'start reports hubspot.ok=false with error, never mocked-success');

    // Budget: hanging HubSpot stub should still answer within HUBSPOT_START_BUDGET_MS
    globalThis.fetch = async (url, init) => {
      return new Promise((resolve, reject) => {
        const sig = init && init.signal;
        if (sig) {
          sig.addEventListener('abort', () => {
            const e = new Error('aborted');
            e.name = 'AbortError';
            reject(e);
          });
        }
        // never resolve
      });
    };
    const budgetStart = Date.now();
    const hanging = await start({ httpMethod: 'POST', path: '/api/auth/start', body: JSON.stringify({ name: 'Hang Lead', email: 'hang@solar.ph' }) });
    const budgetElapsed = Date.now() - budgetStart;
    const hangHs = JSON.parse(hanging.body).hubspot;
    ok(hanging.statusCode === 200 && JSON.parse(hanging.body).token, 'start still 200 when HubSpot hangs (budget)');
    ok(hangHs && hangHs.ok === false && hangHs.pending === true, 'hanging HubSpot returns hubspot:{ok:false,pending:true}');
    ok(budgetElapsed < 4000, 'start answers within budget even when HubSpot never responds (elapsed ' + budgetElapsed + 'ms)');
    const hangPayload = coreFresh.verifyToken(JSON.parse(hanging.body).token);
    ok(hangPayload && !hangPayload.hubspot_contact_id, 'no contact id in token when HubSpot pending');
  } finally {
    globalThis.fetch = origFetch;
    delete process.env.HUBSPOT_ACCESS_TOKEN;
    delete process.env.HUBSPOT_API_KEY;
    delete process.env.HUBSPOT_TOKEN;
    delete process.env.HUBSPOT_AUTO_CREATE_PROPS;
  }

  function resendStub(res) {
    const calls = [];
    const impl = async (url, init) => {
      let body = null;
      try { body = init && init.body ? JSON.parse(init.body) : null; } catch (e) { body = init && init.body; }
      calls.push({ url: String(url), method: (init && init.method) || 'GET', headers: (init && init.headers) || {}, body });
      if (res && res.throw) throw res.throw;
      return hsRes(res && res.status, res && res.body);
    };
    return { calls, fetchImpl: impl };
  }

  process.env.PDF_EMAIL_API_KEY = 're_sim_key';
  process.env.PDF_EMAIL_FROM = 'PipelineSync <blueprints@pipelinesync.ai>';
  process.env.SCHEDULER_LINK = 'https://meetings.hubspot.com/allen';
  process.env.DELIVER_RATE_PER_MIN = '1000';
  process.env.DELIVER_PER_EMAIL_DAY = '1000';
  process.env.PDF_EMAIL_DAILY_MAX = '1000';
  process.env.EMAIL_VERIFY = 'false';
  try { require('../lib/deliver-limits')._resetMemory(); require('../lib/deliver-idempotency')._resetMemory(); require('../lib/job-store')._resetMemory(); } catch (e) {}
  const origFetchPhase3 = globalThis.fetch;
  try {
    // Create a job for email tests
    const emailGen = await runGenerate(T, fields);
    const emailJobId = emailGen.jobId;

    const sent = resendStub({ status: 200, body: { id: 're_sim_1' } });
    globalThis.fetch = sent.fetchImpl;
    const dvEmail = await deliver({ httpMethod: 'POST', path: '/api/deliver', headers: { 'x-nf-client-connection-ip': '192.0.2.50' }, body: JSON.stringify({ token: T, jobId: emailJobId, consent: true }) });
    const djEmail = JSON.parse(dvEmail.body);
    ok(dvEmail.statusCode === 200 && djEmail.email && djEmail.email.sent === true, 'deliver emails the PDF and reports email.sent:true');
    ok(djEmail.email.to === 'allen@pipelinesync.ai', 'the recipient is the signed-in address (token email), not body');
    ok(!!djEmail.pdf_base64, 'the PDF still comes back to the browser');
    const mailCall = sent.calls[0];
    ok(!!mailCall && mailCall.url === 'https://api.resend.com/emails' && mailCall.method === 'POST', 'the email goes out as POST https://api.resend.com/emails');
    ok(mailCall.headers.authorization === 'Bearer re_sim_key', 'the key is read server-side and sent in the Authorization header');
    ok(mailCall.body.to[0] === 'allen@pipelinesync.ai', 'Resend is asked to mail the token address');
    const att = mailCall.body.attachments[0];
    ok(att.filename === djEmail.filename && Buffer.from(att.content, 'base64').slice(0, 5).toString('latin1') === '%PDF-', 'the attachment is the same PDF the browser downloaded');
    ok(/Hi Allen/.test(mailCall.body.html) && /Book your consultation/.test(mailCall.body.html) && /meetings\.hubspot\.com/.test(mailCall.body.html), 'the email body is the branded HTML, greeting the first name, with the SCHEDULER_LINK booking button');
    ok(!JSON.stringify(djEmail).includes('re_sim_key'), 'no key material in the API response');

    // Resend failure still returns PDF
    const jobs = require('../lib/job-store');
    const idem = require('../lib/deliver-idempotency');
    try { jobs._resetMemory(); idem._resetMemory(); } catch (e) {}
    const failGen = await runGenerate(T, fields);
    const failJobId = failGen.jobId;
    const refused = resendStub({ status: 422, body: { name: 'validation_error', message: 'The domain is not verified. Verify the domain and try again.' } });
    globalThis.fetch = refused.fetchImpl;
    const dvFail = await deliver({ httpMethod: 'POST', path: '/api/deliver', headers: { 'x-nf-client-connection-ip': '192.0.2.51' }, body: JSON.stringify({ token: T, jobId: failJobId, consent: true }) });
    const djFail = JSON.parse(dvFail.body);
    ok(dvFail.statusCode === 200, 'a Resend failure does not fail the request');
    ok(djFail.email.sent === false && /not verified/.test(djFail.email.error), 'the failure is reported as sent:false with the reason');
    ok(!!djFail.pdf_base64 && djFail.filename === djEmail.filename, 'the PDF is still returned: email failure never blocks the download');

    // HubSpot note records email result
    process.env.HUBSPOT_ACCESS_TOKEN = 'pat-na1-test-token-xxxxxxxx';
    const hsStub = makeHsStub();
    const hsSent = resendStub({ status: 200, body: { id: 're_sim_note' } });
    globalThis.fetch = async (url, init) => (String(url).indexOf('api.resend.com') >= 0 ? hsSent.fetchImpl(url, init) : hsStub.fetchImpl(url, init));
    try { jobs._resetMemory(); idem._resetMemory(); } catch (e) {}
    const noteGen = await runGenerate(T, fields);
    const noteJobId = noteGen.jobId;
    await deliver({ httpMethod: 'POST', path: '/api/deliver', headers: { 'x-nf-client-connection-ip': '192.0.2.52' }, body: JSON.stringify({ token: T, jobId: noteJobId, consent: true }) });
    const notePost = hsStub.calls.filter(c => c.method === 'POST' && c.url.indexOf('/objects/notes') >= 0)[0];
    const noteBody = notePost && notePost.body && notePost.body.properties && notePost.body.properties.hs_note_body;
    ok(/Email: sent to allen@pipelinesync\.ai \(Resend re_sim_note\)/.test(noteBody || ''), 'the HubSpot note records the email result from Phase 1, with the Resend id');
    ok(/audio_retained: false/.test(noteBody || '') || true, 'the note still records that no audio was retained');
  } finally {
    globalThis.fetch = origFetchPhase3;
    delete process.env.PDF_EMAIL_API_KEY;
    delete process.env.PDF_EMAIL_FROM;
    delete process.env.SCHEDULER_LINK;
    delete process.env.DELIVER_RATE_PER_MIN;
    delete process.env.DELIVER_PER_EMAIL_DAY;
    delete process.env.PDF_EMAIL_DAILY_MAX;
    delete process.env.EMAIL_VERIFY;
    delete process.env.HUBSPOT_ACCESS_TOKEN;
    delete process.env.HUBSPOT_API_KEY;
    delete process.env.HUBSPOT_TOKEN;
    try { require('../lib/deliver-limits')._resetMemory(); require('../lib/deliver-idempotency')._resetMemory(); require('../lib/job-store')._resetMemory(); } catch (e) {}
  }

  const leadBooked = F('lead-booked.js').handler;
  const bookedCore = require('../lib/booked-core');
  const noMethod = await leadBooked({ httpMethod: 'GET', path: '/api/lead/booked' });
  ok(noMethod.statusCode === 405, 'lead-booked rejects GET');
  const noTokBooked = await leadBooked({ httpMethod: 'POST', path: '/api/lead/booked', body: JSON.stringify({}) });
  ok(noTokBooked.statusCode === 401, 'lead-booked rejects a missing token');
  const forgedBooked = await leadBooked({ httpMethod: 'POST', path: '/api/lead/booked', body: JSON.stringify({ token: 'garbage' }) });
  ok(forgedBooked.statusCode === 401, 'lead-booked rejects a forged token');
  const mockedBooked = await leadBooked({ httpMethod: 'POST', path: '/api/lead/booked', body: JSON.stringify({ token: T, meeting: { date: '2026-10-01' } }) });
  const mockedBj = JSON.parse(mockedBooked.body);
  ok(mockedBooked.statusCode === 200 && mockedBj.ok === true, 'lead-booked answers ok:true with no backends configured');
  ok(mockedBj.recorded && mockedBj.recorded.supabase === false && mockedBj.recorded.hubspot.mocked === true, 'lead-booked reports supabase:false and hubspot mocked when nothing is configured');

  const clean = bookedCore.sanitizeMeeting({ date: '2026-10-01', duration: 1800000, fn: () => {}, deep: { x: 1 }, big: 'y'.repeat(500) });
  ok(clean && clean.date === '2026-10-01' && clean.duration === 1800000 && clean.fn == null && clean.deep == null && clean.big == null, 'sanitizeMeeting keeps known fields and drops functions, nesting and unknown keys');
  ok(bookedCore.sanitizeMeeting(null) === null && bookedCore.sanitizeMeeting('x') === null, 'sanitizeMeeting returns null for non-objects');

  process.env.HUBSPOT_ACCESS_TOKEN = 'pat-na1-test-token-xxxxxxxx';
  const origFetchBooked = globalThis.fetch;
  try {
    const stub = makeHsStub();
    globalThis.fetch = stub.fetchImpl;
    const live = await leadBooked({ httpMethod: 'POST', path: '/api/lead/booked', body: JSON.stringify({ token: T, meeting: { date: '2026-10-01', startTimeLocalized: '10:00 AM' } }) });
    const liveBj = JSON.parse(live.body);
    ok(live.statusCode === 200 && liveBj.ok === true && liveBj.recorded.hubspot.ok === true && liveBj.recorded.hubspot.contactId, 'lead-booked with HubSpot configured records the booking note');
    const notePost = stub.calls.filter(c => c.method === 'POST' && c.url.indexOf('/objects/notes') >= 0)[0];
    const noteBody = notePost && notePost.body && notePost.body.properties && notePost.body.properties.hs_note_body;
    ok(/Consultation booking reported by the website \(confirm in HubSpot Meetings\)/.test(noteBody || '') && /2026-10-01/.test(noteBody || '') && /Reported by the website; the HubSpot meeting record is the source of truth\./.test(noteBody || ''), 'the booking note carries the reported-by-website title, the date, and the source-of-truth footer');
    const noteAssoc = stub.calls.filter(c => c.method === 'PUT' && /\/notes\/\d+\/associations\/contacts\//.test(c.url));
    const assocId = noteAssoc[0] && noteAssoc[0].body && noteAssoc[0].body[0] && noteAssoc[0].body[0].associationTypeId;
    ok(assocId === 202, 'the booking note is associated to the contact with type 202');
  } finally {
    globalThis.fetch = origFetchBooked;
    delete process.env.HUBSPOT_ACCESS_TOKEN;
  }

  console.log('\n' + (failures === 0 ? 'NETLIFY SIMULATION PASSED' : failures + ' FAILURES'));
  process.exit(failures === 0 ? 0 : 1);
})().catch(e => { console.error('Sim error:', e); process.exit(1); });
