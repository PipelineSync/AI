/* PDF delivery (lib/deliver-core.js via netlify/functions/deliver.js and server.js).
 *
 * The finished blueprint PDF is only ever downloaded in the web app. What this proves:
 *  1. /api/deliver takes a jobId and builds the PDF from the server-side job (never body.blueprint)
 *  2. nothing is emailed, even when an old email key is still configured on the host
 *  3. the HubSpot note says the PDF was downloaded in the app, and carries no email line
 *  4. rate limiting (5 per minute per IP)
 *  5. idempotency: a repeat returns the same PDF with duplicate:true and no new deal
 *  6. a Supabase failure does not block the PDF
 *  7. the local dev server mounts the same deliver path
 */

const core = require('../lib/core');
const deliverFn = require('../netlify/functions/deliver.js').handler;
const { startServer } = require('./harness');
const jobs = require('../lib/job-store');
const idempotency = require('../lib/deliver-idempotency');

const TEST_SECRET = 'test-secret-0123456789abcdef';
process.env.PS_TOKEN_SECRET = TEST_SECRET;

const realLog = console.log.bind(console);
const realWarn = console.warn.bind(console);
const hush = (...args) => !/^\[(hubspot-mock|hubspot|security)\]/.test(String(args[0] || ''));
console.log = (...args) => { if (hush(...args)) realLog(...args); };
console.warn = (...args) => { if (hush(...args)) realWarn(...args); };

let failures = 0;
const ok = (cond, msg) => { console.log((cond ? '  PASS  ' : '  FAIL  ') + msg); if (!cond) failures++; };
const section = t => console.log('\n' + t);

const persona = require('./personas.json').solar;
const answers = Object.entries(persona.answers).map(([id, text]) => ({ id, text }));
const fields = core.extract(answers);
const blueprint = core.generate(fields);
const filename = core.pdfFilename(blueprint);
const SESSION = { email: 'maria@solarworks.ph', name: 'Maria Santos' };
const token = core.signToken({
  email: SESSION.email, name: SESSION.name,
  lead_id: null, hubspot_contact_id: null,
  exp: Date.now() + core.TOKEN_TTL_MS
});

function stubRes(status, body) {
  const text = body == null ? '' : (typeof body === 'string' ? body : JSON.stringify(body));
  return { ok: status >= 200 && status < 300, status, headers: { get() { return null; } }, async text() { return text; } };
}
/* HubSpot is stubbed; anything else (an email provider included) is recorded and refused. */
function makeStub() {
  const calls = [];
  let contactSeq = 1000, dealSeq = 2000, noteSeq = 3000;
  const fetchImpl = async (url, init) => {
    const u = String(url);
    const method = (init && init.method) || 'GET';
    let parsed = null;
    try { parsed = init && init.body ? JSON.parse(init.body) : null; } catch (e) { parsed = init && init.body; }
    calls.push({ url: u, method, body: parsed });
    if (u.indexOf('api.hubapi.com') >= 0) {
      const path = u.split('?')[0];
      if (u.indexOf('/objects/contacts/search') >= 0) return stubRes(200, { total: 0, results: [] });
      if (method === 'POST' && /\/objects\/contacts\/?$/.test(path)) return stubRes(200, { id: String(++contactSeq), properties: (parsed && parsed.properties) || {} });
      if (method === 'POST' && /\/objects\/deals\/?$/.test(path)) return stubRes(200, { id: String(++dealSeq), properties: (parsed && parsed.properties) || {} });
      if (method === 'POST' && /\/objects\/notes\/?$/.test(path)) return stubRes(200, { id: String(++noteSeq), properties: (parsed && parsed.properties) || {} });
      if (method === 'PUT' && u.indexOf('/associations/') >= 0) return stubRes(200, {});
    }
    return stubRes(404, { message: 'not stubbed ' + u });
  };
  return { fetchImpl, calls };
}
const offHubSpot = calls => calls.filter(c => c.url.indexOf('api.hubapi.com') < 0);
const noteCalls = calls => calls.filter(c => c.method === 'POST' && c.url.indexOf('/objects/notes') >= 0);

async function callDeliver(body, stub, ip) {
  const orig = globalThis.fetch;
  globalThis.fetch = stub ? stub.fetchImpl : orig;
  try {
    const res = await deliverFn({
      httpMethod: 'POST', path: '/api/deliver',
      headers: ip ? { 'x-nf-client-connection-ip': ip } : {},
      body: JSON.stringify(body)
    });
    return { statusCode: res.statusCode, headers: res.headers, json: JSON.parse(res.body || '{}') };
  } finally {
    globalThis.fetch = orig;
  }
}
async function createTestJob(email) {
  const jobId = jobs.newJobId();
  await jobs.put(jobId, {
    status: 'done', step: 'done', label: 'Blueprint ready', progress: 100,
    source: 'fallback', blueprint, email: (email || SESSION.email).toLowerCase(),
    leadId: null, lead_id: null, fields
  }, { env: process.env });
  return jobId;
}
const deliverBody = (jobId, extra) => Object.assign({ token, jobId: jobId || 'missing', consent: true }, extra || {});
const reset = () => { try { require('../lib/deliver-limits')._resetMemory(); jobs._resetMemory(); idempotency._resetMemory(); } catch (e) {} };

(async () => {
  delete process.env.HUBSPOT_ACCESS_TOKEN;
  delete process.env.DELIVER_RATE_PER_MIN;
  process.env.DELIVER_PER_EMAIL_DAY = '1000';
  reset();

  section('deliver: server-side blueprint only, jobId required');
  {
    const jobId = await createTestJob();
    const stub = makeStub();
    const out = await callDeliver(deliverBody(jobId), stub, '198.51.100.10');
    ok(out.statusCode === 200 && out.json.ok === true, 'deliver 200 with valid jobId');
    const pdf = Buffer.from(out.json.pdf_base64 || '', 'base64');
    ok(pdf.slice(0, 8).toString('latin1').startsWith('%PDF-1.4'), 'the PDF comes back to the browser to download');
    ok(out.json.filename === filename, 'the filename matches the blueprint');
    const bad = await callDeliver({ token, jobId: 'deadbeefdeadbeef', consent: true, blueprint: { meta: { verticalLabel: 'Fake' } } }, makeStub(), '198.51.100.11');
    ok(bad.statusCode === 404 && !bad.json.pdf_base64, 'a hand-made blueprint without a valid jobId gets 404 and no PDF');
    const noConsent = await callDeliver({ token, jobId, consent: false }, makeStub(), '198.51.100.12');
    ok(noConsent.statusCode === 400, 'consent is still required');
  }

  section('nothing is emailed, even with an old email key still configured');
  process.env.PDF_EMAIL_API_KEY = 're_leftover_key';
  process.env.PDF_EMAIL_FROM = 'PipelineSync <blueprints@pipelinesync.ai>';
  try {
    reset();
    const jobId = await createTestJob();
    const stub = makeStub();
    const out = await callDeliver(deliverBody(jobId), stub, '198.51.100.13');
    ok(out.statusCode === 200 && !!out.json.pdf_base64, 'the PDF is returned');
    ok(!('email' in out.json), 'the response carries no email result');
    ok(offHubSpot(stub.calls).length === 0, 'no request goes anywhere but HubSpot (no email provider)');
    const asked = await callDeliver(deliverBody(jobId, { resendEmail: true, code: '123456' }), stub, '198.51.100.13');
    ok(asked.statusCode === 200 && asked.json.duplicate === true && offHubSpot(stub.calls).length === 0,
      'an old client asking for a resend or sending a code gets the same PDF and still nothing is emailed');
  } finally {
    delete process.env.PDF_EMAIL_API_KEY;
    delete process.env.PDF_EMAIL_FROM;
  }

  section('the HubSpot note says how the PDF reached the lead');
  process.env.HUBSPOT_ACCESS_TOKEN = 'pat-na1-test-token-xxxxxxxx';
  try {
    reset();
    const jobId = await createTestJob();
    const stub = makeStub();
    await callDeliver(deliverBody(jobId), stub, '198.51.100.14');
    const note = noteCalls(stub.calls)[0];
    const body = note && note.body && note.body.properties && note.body.properties.hs_note_body;
    ok(!!body, 'a note was created on the contact');
    ok(/PDF: downloaded by the lead in the web app \(not emailed\)/.test(body || ''), 'the note says the PDF was downloaded in the app');
    ok(!/Email: (sent|NOT sent)/.test(body || ''), 'the note has no email line');
  } finally { delete process.env.HUBSPOT_ACCESS_TOKEN; }

  section('deliver is limited to 5 per minute per IP (the deployed function)');
  {
    reset();
    const stub = makeStub();
    const results = [];
    for (let i = 0; i < 6; i++) {
      jobs._resetMemory(); idempotency._resetMemory();
      results.push(await callDeliver(deliverBody(await createTestJob()), stub, '203.0.113.77'));
    }
    ok(results.slice(0, 5).every(r => r.statusCode === 200), 'the first five attempts in the minute are served');
    ok(results[5].statusCode === 429, 'the sixth is refused with 429');
    ok(/Too many unlock attempts/.test(results[5].json.error || ''), 'the 429 explains itself');
    ok(Number(results[5].headers['retry-after'] || results[5].headers['Retry-After']) > 0, 'the 429 carries Retry-After');
    ok(!results[5].json.pdf_base64, 'a refused attempt builds nothing');
    const other = await callDeliver(deliverBody(await createTestJob()), stub, '203.0.113.78');
    ok(other.statusCode === 200, 'the limit is per IP, not global');
    process.env.DELIVER_RATE_PER_MIN = '1000';
    jobs._resetMemory(); idempotency._resetMemory();
    const rolled = await callDeliver(deliverBody(await createTestJob()), stub, '203.0.113.77');
    ok(rolled.statusCode === 200, 'DELIVER_RATE_PER_MIN overrides the default');
    delete process.env.DELIVER_RATE_PER_MIN;
  }

  section('idempotency: a repeat returns the same PDF with duplicate:true and no new deal');
  process.env.HUBSPOT_ACCESS_TOKEN = 'pat-na1-test-token-xxxxxxxx';
  try {
    reset();
    const jobId = await createTestJob();
    const stub = makeStub();
    const first = await callDeliver(deliverBody(jobId), stub, '198.51.100.20');
    ok(first.statusCode === 200 && !first.json.duplicate, 'first delivery is not a duplicate');
    const callsAfterFirst = stub.calls.length;
    const second = await callDeliver(deliverBody(jobId), stub, '198.51.100.20');
    ok(second.statusCode === 200 && second.json.duplicate === true && !!second.json.pdf_base64, 'a repeat returns duplicate:true with the PDF');
    ok(stub.calls.length === callsAfterFirst, 'a repeat creates no new contact, deal or note');
  } finally { delete process.env.HUBSPOT_ACCESS_TOKEN; }

  section('a Supabase failure does not block the PDF');
  {
    reset();
    const jobId = await createTestJob();
    const leads = require('../lib/supabase-leads');
    const saved = { save: leads.saveBlueprint, update: leads.updateLead, add: leads.addEvent, on: leads.isEnabled };
    leads.isEnabled = () => true;
    leads.saveBlueprint = async () => { throw new Error('supabase down'); };
    leads.updateLead = async () => {};
    leads.addEvent = async () => {};
    try {
      const tokenWithLead = core.signToken({ email: SESSION.email, name: SESSION.name, lead_id: 'lead-123', exp: Date.now() + core.TOKEN_TTL_MS });
      const out = await callDeliver({ token: tokenWithLead, jobId, consent: true }, makeStub(), '198.51.100.21');
      ok(out.statusCode === 200, 'a Supabase failure returns 200, not 503');
      ok(out.json.persistence && out.json.persistence.ok === false, 'persistence:{ok:false} is reported');
      ok(!!out.json.pdf_base64, 'the PDF is still returned');
    } finally {
      leads.saveBlueprint = saved.save; leads.updateLead = saved.update; leads.addEvent = saved.add; leads.isEnabled = saved.on;
    }
  }

  section('the local dev server mounts the same deliver path (jobId)');
  const srv = await startServer(8097, { DELIVER_RATE_PER_MIN: '5', PS_TOKEN_SECRET: TEST_SECRET });
  try {
    const postJSON = async (path, body) => {
      const r = await fetch(srv.base + path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
      return { code: r.status, headers: r.headers, j: await r.json().catch(() => ({})) };
    };
    const tok = (await postJSON('/api/auth/start', { name: SESSION.name, email: SESSION.email })).j.token;
    const newJob = async () => {
      const ex = (await postJSON('/api/extract', { token: tok, answers })).j;
      const start = (await postJSON('/api/generate', { token: tok, fields: ex.fields })).j;
      for (let i = 0; i < 40; i++) {
        await new Promise(r => setTimeout(r, 80));
        const st = await (await fetch(srv.base + '/api/generate/status?jobId=' + start.jobId + '&token=' + encodeURIComponent(tok))).json();
        if (st.status === 'done') return start.jobId;
      }
      return start.jobId;
    };
    const first = await postJSON('/api/deliver', { token: tok, jobId: await newJob(), consent: true, voice_meta: { provider: 'simulated', mode: 'simulated', turns: 12, audio_retained: false } });
    ok(first.code === 200 && !!first.j.pdf_base64 && first.j.filename.endsWith('.pdf'), 'a local deliver returns the PDF to download');
    ok(!('email' in first.j), 'the local server reports no email either');
    const gone = await postJSON('/api/deliver/code', { token: tok });
    ok(gone.code === 404, 'the email code endpoint no longer exists');
    for (let i = 0; i < 4; i++) await postJSON('/api/deliver', { token: tok, jobId: await newJob(), consent: true });
    const sixth = await postJSON('/api/deliver', { token: tok, jobId: await newJob(), consent: true });
    ok(sixth.code === 429 && Number(sixth.headers.get('retry-after')) > 0, 'the dev server enforces the same 5/minute limit');
    const outbox = (await (await fetch(srv.base + '/dev/outbox')).text()).replace(/&quot;/g, '"');
    ok(!/pdf_email|PDF emailed/.test(outbox), 'the dev outbox has no email column');
    ok(/"voice_call"/.test(outbox) && /"audio_retained": false/.test(outbox), 'the voice-call metadata in the outbox is untouched');
  } finally {
    srv.stop();
  }

  console.log('\n' + (failures === 0 ? 'DELIVERY TESTS PASSED' : failures + ' FAILURE(S)'));
  process.exit(failures === 0 ? 0 : 1);
})().catch(e => { console.error('Delivery test error:', e); process.exit(1); });
