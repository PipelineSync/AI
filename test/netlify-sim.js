/* Simulates Netlify invoking the functions with Lambda-style events,
   so the deployed code path is tested before pushing to GitHub. */
const path = require('path');
const hubspot = require('../lib/hubspot');
const core = require('../lib/core');
const F = dir => require(path.join(__dirname, '..', 'netlify', 'functions', dir));
const start = F('start.js').handler;
const login = F('login.js').handler;   // alias of start.js
const logout = F('logout.js').handler;
const extract = F('extract.js').handler;
const generate = F('generate.js').handler;
const deliver = F('deliver.js').handler;
const outbox = F('outbox.js').handler;
const voiceFn = F('voice.js').handler;
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
    headers: {
      get(k) {
        const want = String(k).toLowerCase();
        for (const [hk, hv] of Object.entries(hdrs)) if (String(hk).toLowerCase() === want) return hv;
        return null;
      }
    },
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
      const email = parsed && parsed.filterGroups && parsed.filterGroups[0]
        && parsed.filterGroups[0].filters && parsed.filterGroups[0].filters[0]
        && parsed.filterGroups[0].filters[0].value;
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
    if (method === 'PUT' && u.indexOf('/associations/') >= 0) {
      return hsRes(200, {});
    }
    if (method === 'POST' && /\/crm\/v3\/properties\//.test(u)) {
      return hsRes(201, { name: parsed && parsed.name });
    }
    return hsRes(404, { message: 'not stubbed ' + u });
  };
  return { fetchImpl, calls, contacts };
}

function searchCalls(calls) {
  return calls.filter(c => c.url.indexOf('/contacts/search') >= 0);
}
function createContactCalls(calls) {
  return calls.filter(c => c.method === 'POST' && /\/objects\/contacts\/?$/.test(c.url.split('?')[0]));
}
function patchContactCalls(calls) {
  return calls.filter(c => c.method === 'PATCH' && c.url.indexOf('/objects/contacts/') >= 0);
}

(async () => {
  // Hermetic: a developer token in the shell must not make these function tests hit live HubSpot.
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

  const alias = await login({ httpMethod: 'POST', path: '/api/auth/login', body: JSON.stringify({ name: 'Allen Reyes', email: 'allen@pipelinesync.ai' }) });
  ok(alias.statusCode === 200 && JSON.parse(alias.body).token, 'the login function still serves the entry gate (alias)');

  // token must verify across "cold starts": require the core fresh
  delete require.cache[require.resolve('../lib/core')];
  const coreFresh = require('../lib/core');
  ok(!!coreFresh.verifyToken(T), 'token verifies in a fresh module instance (stateless auth)');

  const p = personas.solar;
  const answers = Object.entries(p.answers).map(([id, text]) => ({ id, text }));
  const ex = await extract({ httpMethod: 'POST', path: '/api/extract', body: JSON.stringify({ token: T, answers }) });
  ok(ex.statusCode === 200, 'extract function 200');
  const fields = JSON.parse(ex.body).fields;

  const gen = await generate({ httpMethod: 'POST', path: '/api/generate', body: JSON.stringify({ token: T, fields }) });
  ok(gen.statusCode === 200, 'generate function 200');
  const bp = JSON.parse(gen.body).blueprint;

  const dv = await deliver({ httpMethod: 'POST', path: '/api/deliver', body: JSON.stringify({ token: T, email: 'owner@solar.ph', consent: true, fields, blueprint: bp }) });
  ok(dv.statusCode === 200, 'deliver function 200');
  const dj = JSON.parse(dv.body);
  ok(!!dj.contact_id && !!dj.pdf_base64, 'deliver returns contact id + base64 pdf');
  ok(dj.hubspot && dj.hubspot.mocked === true && dj.lead_pushed === false, 'mocked deliver does not claim a live HubSpot push');
  const pdf = Buffer.from(dj.pdf_base64, 'base64');
  ok(pdf.slice(0, 8).toString('latin1').startsWith('%PDF-1.4'), 'function-generated pdf is valid');

  // base64-encoded body (Netlify may send binary bodies this way)
  const exB64 = await extract({ httpMethod: 'POST', path: '/api/extract', isBase64Encoded: true, body: Buffer.from(JSON.stringify({ token: T, answers })).toString('base64') });
  ok(exB64.statusCode === 200, 'extract handles base64-encoded body');

  // auth failures
  const noTok = await extract({ httpMethod: 'POST', path: '/api/extract', body: JSON.stringify({ answers }) });
  ok(noTok.statusCode === 401, 'extract rejects missing token');
  const badTok = await extract({ httpMethod: 'POST', path: '/api/extract', body: JSON.stringify({ token: 'garbage', answers }) });
  ok(badTok.statusCode === 401, 'extract rejects forged token');

  // voice layer through the Netlify function (same handler the dev server mounts)
  const vs = await voiceFn({ httpMethod: 'POST', path: '/api/voice/session', body: JSON.stringify({ token: T }) });
  ok(vs.statusCode === 200 && JSON.parse(vs.body).plan.length === 12, 'voice function serves the call plan through /api/voice/*');
  const vturn = await voiceFn({ httpMethod: 'POST', path: '/api/voice/turn', body: JSON.stringify({ token: T, call_id: 'sim-1', answers: [], asked: [], probes: {}, with_audio: false }) });
  const vj = JSON.parse(vturn.body);
  ok(vturn.statusCode === 200 && vj.ask.id === 'business', 'voice function serves a turn and the guardrail question');
  const vsub = await voiceFn({ httpMethod: 'POST', path: '/.netlify/functions/voice', queryStringParameters: { op: 'speak' }, body: JSON.stringify({ token: T, text: 'Testing.' }) });
  ok(vsub.statusCode === 200, 'voice function resolves its sub-route from the function path');
  const vno = await voiceFn({ httpMethod: 'POST', path: '/api/voice/turn', body: JSON.stringify({}) });
  ok(vno.statusCode === 401, 'voice function rejects a missing token');

  const ob = await outbox({ httpMethod: 'GET', path: '/dev/outbox' });
  ok(ob.statusCode === 200 && ob.body.includes('function logs'), 'outbox page explains where leads go on Netlify');

  const lo = await logout({ httpMethod: 'POST', path: '/api/auth/logout', body: JSON.stringify({ token: T }) });
  ok(lo.statusCode === 200, 'logout ok');

  /* ---- HubSpot: unit + stubbed fetch (never hits api.hubapi.com) ---- */
  hubspot.setSleep(async () => {});
  hubspot.resetForTests();
  ok(hubspot.ASSOC.NOTE_TO_CONTACT === 202, 'note→contact associationTypeId is 202 (not 201)');
  ok(hubspot.ASSOC.NOTE_TO_DEAL === 214, 'note→deal associationTypeId is 214');

  const createdProps = hubspot.buildContactProperties('new@ex.com', 'Maria Santos', null, null, { onCreate: true });
  ok(createdProps.lifecyclestage === 'lead' && createdProps.hs_lead_status === 'NEW', 'create sets lifecyclestage=lead and hs_lead_status=NEW');
  ok(createdProps.firstname === 'Maria' && createdProps.lastname === 'Santos' && createdProps.pipelinesync_source === 'pipelinesync_ai', 'create writes name split + lead source');
  const updatedProps = hubspot.buildContactProperties('new@ex.com', 'Maria Santos', null, null, { onCreate: false });
  ok(updatedProps.lifecyclestage == null && updatedProps.hs_lead_status == null, 'update does not set lifecycle or lead status (no demotion)');

  const unknownErr = {
    status: 400,
    message: 'Property values were not valid: [{"isValid":false,"message":"Property \\"pipelinesync_headache\\" does not exist","error":"PROPERTY_DOESNT_EXIST","name":"pipelinesync_headache"}]',
    data: {
      message: 'Property values were not valid: [{"name":"pipelinesync_headache"}]',
      errors: [{ name: 'pipelinesync_headache', message: 'Property "pipelinesync_headache" does not exist' }]
    }
  };
  const dropped = hubspot.parseUnknownPropertyNames(unknownErr, ['email', 'firstname', 'pipelinesync_source', 'pipelinesync_headache']);
  ok(dropped.includes('pipelinesync_headache') && !dropped.includes('email') && !dropped.includes('pipelinesync_source'),
    'unknown-property parser drops only the named field');

  const liveEnv = { HUBSPOT_ACCESS_TOKEN: 'pat-na1-test-token-xxxxxxxx' };

  // Create: search miss → POST contact with lifecycle
  {
    const stub = makeHsStub();
    const r = await hubspot.captureLead({ email: 'create@solar.ph', name: 'Create Lead', env: liveEnv, fetchImpl: stub.fetchImpl });
    ok(r.ok === true && r.mocked === false && r.contactId, 'captureLead create returns ok + contactId');
    const created = createContactCalls(stub.calls);
    ok(created.length === 1, 'create path POSTs the contact once');
    const props = created[0].body && created[0].body.properties;
    ok(props && props.lifecyclestage === 'lead' && props.hs_lead_status === 'NEW', 'create POST includes lifecycle + NEW lead status');
    ok(props && props.email === 'create@solar.ph' && props.firstname === 'Create' && props.pipelinesync_source === 'pipelinesync_ai',
      'create POST includes email, firstname, lead source');
  }

  // Update: existing contact is PATCHed without lifecycle demotion
  {
    const stub = makeHsStub({
      contacts: {
        'existing@solar.ph': { id: '99', properties: { email: 'existing@solar.ph', lifecyclestage: 'customer', hs_lead_status: 'OPEN' } }
      }
    });
    const r = await hubspot.upsertContact({ email: 'existing@solar.ph', name: 'Existing Lead', env: liveEnv, fetchImpl: stub.fetchImpl });
    ok(r.contactId === '99' && r.createdContact === false, 'upsert finds the existing contact and updates it');
    ok(createContactCalls(stub.calls).length === 0, 'update path does not POST a new contact');
    const patches = patchContactCalls(stub.calls);
    ok(patches.length === 1, 'update path PATCHes the existing contact');
    const props = patches[0].body && patches[0].body.properties;
    ok(props && props.lifecyclestage == null && props.hs_lead_status == null, 'update PATCH never sends lifecyclestage or hs_lead_status');
    ok(props && props.email === 'existing@solar.ph' && props.pipelinesync_source === 'pipelinesync_ai', 'update PATCH still writes email + lead source');
  }

  // 429 retry with exponential backoff (sleep is no-op in tests)
  {
    const stub = makeHsStub({
      failPlan: [
        { path: '/contacts/search', times: 2, status: 429, headers: { 'Retry-After': '0' }, body: { message: 'rate limited' } }
      ]
    });
    const r = await hubspot.captureLead({ email: 'retry@solar.ph', name: 'Retry Lead', env: liveEnv, fetchImpl: stub.fetchImpl });
    ok(r.ok === true && r.contactId, '429 then success still captures the lead');
    ok(searchCalls(stub.calls).length === 3, '429 is retried up to 3 tries (2 failures + 1 success)');
  }

  // Partial property drop: only the named unknown property is stripped
  {
    const unknownBody = {
      status: 'error',
      message: 'Property values were not valid: [{"isValid":false,"message":"Property \\"pipelinesync_headache\\" does not exist","error":"PROPERTY_DOESNT_EXIST","name":"pipelinesync_headache"}]',
      errors: [{ name: 'pipelinesync_headache', message: 'Property "pipelinesync_headache" does not exist' }]
    };
    const stub = makeHsStub({
      failPlan: [
        { path: '/crm/v3/objects/contacts', notPath: '/search', method: 'POST', times: 1, status: 400, body: unknownBody }
      ]
    });
    const r = await hubspot.upsertContact({
      email: 'drop@solar.ph', name: 'Drop Lead',
      fields: { biggest_headache: 'Follow-ups slip', industry: 'solar' },
      env: liveEnv, fetchImpl: stub.fetchImpl
    });
    ok(r.contactId && !r.error, 'upsert succeeds after dropping the unknown property');
    const posts = createContactCalls(stub.calls);
    ok(posts.length === 2, 'unknown-property 400 retries the create once (got ' + posts.length + ')');
    const first = posts[0] && posts[0].body && posts[0].body.properties;
    const second = posts[1] && posts[1].body && posts[1].body.properties;
    ok(!!first && first.pipelinesync_headache === 'Follow-ups slip' && first.pipelinesync_source === 'pipelinesync_ai' && first.pipelinesync_industry === 'solar',
      'first create includes the unknown property plus other custom fields');
    ok(!!second && second.pipelinesync_headache == null && second.pipelinesync_source === 'pipelinesync_ai' && second.pipelinesync_industry === 'solar' && second.email === 'drop@solar.ph',
      'retry drops only pipelinesync_headache and keeps source, industry, email');
  }

  // Note → contact association type id 202
  {
    const stub = makeHsStub();
    const r = await hubspot.pushLead({
      email: 'note@solar.ph', name: 'Note Lead',
      fields: { industry: 'solar', typical_deal_size: 1500000, biggest_headache: 'Follow-ups slip' },
      blueprint: bp,
      env: liveEnv, fetchImpl: stub.fetchImpl
    });
    ok(r.contactId && r.dealId && !r.mocked, 'pushLead creates contact + deal');
    const noteAssoc = stub.calls.filter(c => c.method === 'PUT' && /\/notes\/\d+\/associations\/contacts\//.test(c.url));
    ok(noteAssoc.length >= 1, 'note is associated to the contact');
    const typeId = noteAssoc[0].body && noteAssoc[0].body[0] && noteAssoc[0].body[0].associationTypeId;
    ok(typeId === 202, 'note→contact associationTypeId is 202');
  }

  // Live start + deliver through the Netlify functions, reusing hubspot_contact_id
  const origFetch = globalThis.fetch;
  process.env.HUBSPOT_ACCESS_TOKEN = 'pat-na1-test-token-xxxxxxxx';
  try {
    const liveStub = makeHsStub();
    globalThis.fetch = liveStub.fetchImpl;

    const liveStart = await start({
      httpMethod: 'POST', path: '/api/auth/start',
      body: JSON.stringify({ name: 'Maria Live', email: 'maria-live@solar.ph' })
    });
    ok(liveStart.statusCode === 200, 'live start still 200 with a stubbed HubSpot');
    const liveBody = JSON.parse(liveStart.body);
    ok(liveBody.hubspot && liveBody.hubspot.ok === true && liveBody.hubspot.contactId && liveBody.hubspot.mocked === false,
      'live start reports hubspot.ok with a contactId');
    const liveTok = liveBody.token;
    const livePayload = coreFresh.verifyToken(liveTok);
    ok(livePayload && livePayload.hubspot_contact_id === liveBody.hubspot.contactId,
      'signed token carries hubspot_contact_id from start');
    const searchesAfterStart = searchCalls(liveStub.calls).length;
    ok(searchesAfterStart >= 1, 'live start searches HubSpot by email');
    ok(createContactCalls(liveStub.calls).length === 1, 'live start creates the contact');

    const liveEx = await extract({ httpMethod: 'POST', path: '/api/extract', body: JSON.stringify({ token: liveTok, answers }) });
    ok(liveEx.statusCode === 200, 'extract after live start 200');
    const liveFields = JSON.parse(liveEx.body).fields;
    const liveGen = await generate({ httpMethod: 'POST', path: '/api/generate', body: JSON.stringify({ token: liveTok, fields: liveFields }) });
    ok(liveGen.statusCode === 200, 'generate after live start 200');
    const liveBp = JSON.parse(liveGen.body).blueprint;

    const liveDv = await deliver({
      httpMethod: 'POST', path: '/api/deliver',
      body: JSON.stringify({ token: liveTok, email: 'maria-live@solar.ph', consent: true, fields: liveFields, blueprint: liveBp })
    });
    ok(liveDv.statusCode === 200, 'live deliver 200');
    const liveDj = JSON.parse(liveDv.body);
    ok(liveDj.hubspot && liveDj.hubspot.ok === true && liveDj.hubspot.contactId === liveBody.hubspot.contactId && liveDj.lead_pushed === true,
      'live deliver reuses the start contactId and claims the push');
    const searchesAfterDeliver = searchCalls(liveStub.calls).length;
    ok(searchesAfterDeliver === searchesAfterStart, 'deliver reuses hubspot_contact_id and does not re-search by email');
    ok(liveDj.hubspot.dealId, 'live deliver creates a deal');
    const liveNoteAssoc = liveStub.calls.filter(c => c.method === 'PUT' && /\/notes\/.+\/associations\/contacts\//.test(c.url));
    const liveTypeId = liveNoteAssoc[0] && liveNoteAssoc[0].body && liveNoteAssoc[0].body[0] && liveNoteAssoc[0].body[0].associationTypeId;
    ok(liveTypeId === 202, 'live deliver note→contact associationTypeId is 202');

    // start never fails because of HubSpot
    globalThis.fetch = async () => { throw new Error('HubSpot unreachable'); };
    const down = await start({
      httpMethod: 'POST', path: '/api/auth/start',
      body: JSON.stringify({ name: 'Down Lead', email: 'down@solar.ph' })
    });
    ok(down.statusCode === 200 && JSON.parse(down.body).token, 'start still 200 when HubSpot fetch throws');
    const downHs = JSON.parse(down.body).hubspot;
    ok(downHs && downHs.ok === false && downHs.mocked === false && downHs.error, 'start reports hubspot.ok=false with error, never mocked-success');
  } finally {
    globalThis.fetch = origFetch;
    delete process.env.HUBSPOT_ACCESS_TOKEN;
    delete process.env.HUBSPOT_API_KEY;
    delete process.env.HUBSPOT_TOKEN;
    delete process.env.HUBSPOT_AUTO_CREATE_PROPS;
  }

  console.log('\n' + (failures === 0 ? 'NETLIFY SIMULATION PASSED' : failures + ' FAILURES'));
  process.exit(failures === 0 ? 0 : 1);
})().catch(e => { console.error('Sim error:', e); process.exit(1); });
