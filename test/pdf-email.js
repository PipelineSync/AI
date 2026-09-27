/* Phase 3 — email delivery of the PDF (lib/pdf-email.js + lib/deliver-core.js).
 *
 * Updated for Phase 6 security hardening:
 *  - /api/deliver takes jobId, not blueprint. Server-side blueprint only.
 *  - Token email everywhere, body.email removed.
 *  - Idempotency, email verification, persistence non-blocking.
 *
 * What this proves, without ever touching Resend:
 *  1. the email is built from the blueprint and the session
 *  2. stubbed Resend success/failure
 *  3. recipient is token email, body.email ignored
 *  4. hand-made blueprint without valid jobId gets no PDF
 *  5. HubSpot note records email result
 *  6. rate limiting
 *  7. idempotency duplicate:true, resendEmail
 *  8. Supabase failure does not block PDF (persistence ok:false)
 *  9. local dev server same path
 */

const core = require('../lib/core');
const hubspot = require('../lib/hubspot');
const pdfEmail = require('../lib/pdf-email');
const deliverFn = require('../netlify/functions/deliver.js').handler;
const { startServer } = require('./harness');
const jobs = require('../lib/job-store');
const idempotency = require('../lib/deliver-idempotency');
const emailVerify = require('../lib/email-verify');

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
const pdfBuffer = core.buildPdf(blueprint);
const filename = core.pdfFilename(blueprint);
const PDF_KEY = 're_test_key_do_not_log_me';
const SESSION = { email: 'maria@solarworks.ph', name: 'Maria Santos' };
const token = core.signToken({
  email: SESSION.email, name: SESSION.name,
  lead_id: null, hubspot_contact_id: null,
  exp: Date.now() + core.TOKEN_TTL_MS
});

function stubRes(status, body, headers) {
  const text = body == null ? '' : (typeof body === 'string' ? body : JSON.stringify(body));
  const hdrs = headers || {};
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get(k) { const want = String(k).toLowerCase(); for (const [hk, hv] of Object.entries(hdrs)) if (String(hk).toLowerCase() === want) return hv; return null; } },
    async text() { return text; }
  };
}
function makeStub(plan) {
  plan = plan || {};
  const calls = [];
  let contactSeq = 1000, dealSeq = 2000, noteSeq = 3000;
  const fetchImpl = async (url, init) => {
    const u = String(url);
    const method = (init && init.method) || 'GET';
    let parsed = null;
    try { parsed = init && init.body ? JSON.parse(init.body) : null; } catch (e) { parsed = init && init.body; }
    calls.push({ url: u, method, body: parsed, headers: (init && init.headers) || {} });
    if (u.indexOf('api.resend.com') >= 0) {
      const r = plan.resend || { status: 200, body: { id: 're_stub_1' } };
      if (r.throw) throw r.throw;
      if (r.delayMs) {
        await new Promise((resolve, reject) => {
          const timer = setTimeout(resolve, r.delayMs);
          const signal = init && init.signal;
          if (signal && signal.addEventListener) {
            signal.addEventListener('abort', () => {
              clearTimeout(timer);
              const err = new Error('The operation was aborted');
              err.name = 'AbortError';
              reject(err);
            });
          }
        });
      }
      return stubRes(r.status, r.body);
    }
    if (u.indexOf('api.hubapi.com') >= 0) {
      if (u.indexOf('/objects/contacts/search') >= 0) return stubRes(200, { total: 0, results: [] });
      if (method === 'POST' && /\/objects\/contacts\/?$/.test(u.split('?')[0])) return stubRes(200, { id: String(++contactSeq), properties: (parsed && parsed.properties) || {} });
      if (method === 'POST' && /\/objects\/deals\/?$/.test(u.split('?')[0])) return stubRes(200, { id: String(++dealSeq), properties: (parsed && parsed.properties) || {} });
      if (method === 'POST' && /\/objects\/notes\/?$/.test(u.split('?')[0])) return stubRes(200, { id: String(++noteSeq), properties: (parsed && parsed.properties) || {} });
      if (method === 'PUT' && u.indexOf('/associations/') >= 0) return stubRes(200, {});
      return stubRes(404, { message: 'not stubbed ' + u });
    }
    return stubRes(404, { message: 'not stubbed ' + u });
  };
  return { fetchImpl, calls };
}
const resendCalls = calls => calls.filter(c => c.url.indexOf('api.resend.com') >= 0);
const noteCalls = calls => calls.filter(c => c.method === 'POST' && c.url.indexOf('/objects/notes') >= 0);

async function callDeliver(body, stub, ip) {
  const orig = globalThis.fetch;
  globalThis.fetch = stub ? stub.fetchImpl : orig;
  try {
    const event = {
      httpMethod: 'POST', path: '/api/deliver',
      headers: ip ? { 'x-nf-client-connection-ip': ip } : {},
      body: JSON.stringify(body)
    };
    const res = await deliverFn(event);
    return { statusCode: res.statusCode, headers: res.headers, json: JSON.parse(res.body || '{}') };
  } finally {
    globalThis.fetch = orig;
  }
}

// Create a job record in the store for testing deliver
async function createTestJob(email, f, bp) {
  const jobId = jobs.newJobId();
  await jobs.put(jobId, {
    status: 'done', step: 'done', label: 'Blueprint ready', progress: 100,
    source: 'fallback', blueprint: bp || blueprint,
    email: (email || SESSION.email).toLowerCase(),
    leadId: null, lead_id: null,
    fields: f || fields
  }, { env: process.env });
  return jobId;
}

const deliverBody = (jobId, extra) => Object.assign({
  token, jobId: jobId || 'missing', consent: true
}, extra || {});

const MAIL_ENV = ['PDF_EMAIL_API_KEY', 'PDF_EMAIL_FROM', 'PDF_EMAIL_SUBJECT', 'PDF_EMAIL_REPLY_TO', 'SCHEDULER_LINK', 'DELIVER_PER_EMAIL_DAY', 'PDF_EMAIL_DAILY_MAX', 'DELIVER_RATE_PER_MIN', 'EMAIL_VERIFY'];

function withEmailEnv(fn) {
  const saved = {};
  for (const k of MAIL_ENV) saved[k] = process.env[k];
  process.env.PDF_EMAIL_API_KEY = PDF_KEY;
  process.env.PDF_EMAIL_FROM = 'PipelineSync <blueprints@pipelinesync.ai>';
  process.env.DELIVER_PER_EMAIL_DAY = '1000';
  process.env.PDF_EMAIL_DAILY_MAX = '1000';
  process.env.EMAIL_VERIFY = 'false';
  for (const k of ['PDF_EMAIL_SUBJECT', 'PDF_EMAIL_REPLY_TO', 'SCHEDULER_LINK']) delete process.env[k];
  return Promise.resolve().then(fn).finally(() => {
    for (const k of MAIL_ENV) {
      if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k];
    }
  });
}

(async () => {
  delete process.env.HUBSPOT_ACCESS_TOKEN;
  delete process.env.PDF_EMAIL_API_KEY;
  delete process.env.PDF_EMAIL_FROM;
  delete process.env.DELIVER_RATE_PER_MIN;
  process.env.DELIVER_PER_EMAIL_DAY = '1000';
  process.env.PDF_EMAIL_DAILY_MAX = '1000';
  process.env.EMAIL_VERIFY = 'false';
  try { require('../lib/deliver-limits')._resetMemory(); } catch (e) {}
  try { require('../lib/deliver-idempotency')._resetMemory(); } catch (e) {}
  try { require('../lib/email-verify')._resetMemory(); } catch (e) {}
  try { require('../lib/job-store')._resetMemory(); } catch (e) {}

  section('the feature is off unless the server is configured for it');
  ok(pdfEmail.emailConfig({}) === null && pdfEmail.isEnabled({}) === false, 'no PDF_EMAIL_API_KEY: the feature reports itself as off');
  ok(pdfEmail.emailConfig({ PDF_EMAIL_API_KEY: 're_live_1' }).from === '', 'a key with no PDF_EMAIL_FROM is still read from the environment');
  const off = await pdfEmail.sendBlueprintEmail({ to: SESSION.email, env: {}, pdfBuffer });
  ok(off.sent === false && /PDF_EMAIL_API_KEY is not set/.test(off.error), 'switched off: sent:false with the reason, not a crash');
  ok(pdfEmail.publicEmail(off).configured === false, 'switched off is distinguishable from a failed attempt');
  const noFrom = await pdfEmail.sendBlueprintEmail({ to: SESSION.email, env: { PDF_EMAIL_API_KEY: PDF_KEY }, pdfBuffer });
  ok(noFrom.sent === false && /PDF_EMAIL_FROM/.test(noFrom.error), 'key but no From address: sent:false names the missing variable');
  const badTo = await pdfEmail.sendBlueprintEmail({ to: 'not-an-email', env: { PDF_EMAIL_API_KEY: PDF_KEY, PDF_EMAIL_FROM: 'a@b.co' }, pdfBuffer });
  ok(badTo.sent === false && /No verified email address/.test(badTo.error), 'an unusable recipient is refused before any request is made');

  section('the email body is built from the blueprint and the session');
  const mail = pdfEmail.buildEmail({ blueprint, name: 'Maria Santos', to: SESSION.email, filename, schedulerLink: 'https://meetings.hubspot.com/allen' });
  ok(/^Hi Maria,/.test(mail.text.split('\n')[0]), 'the greeting uses the first name from the session');
  ok(mail.subject === pdfEmail.DEFAULT_SUBJECT, 'the default subject is used when PDF_EMAIL_SUBJECT is unset');
  const sentences = pdfEmail.summarySentences(blueprint, 'Maria');
  ok(sentences.length >= 2 && sentences.length <= 3, 'the summary is 2-3 sentences (' + sentences.length + ')');
  ok(/your solar business/.test(sentences.join(' ')), 'the summary names the vertical from the blueprint');
  ok(sentences.join(' ').includes('Sales Hub Professional'), 'the summary names the recommended tier from the blueprint');
  ok(sentences.join(' ').includes('PHP 16,200,000'), 'the summary reuses the cost of inaction the blueprint computed');
  ok(mail.text.includes('Your blueprint is attached as ' + filename + '.'), 'the body says the blueprint is attached, with the filename');
  ok(mail.html.includes('Book your consultation') && mail.html.includes('https://meetings.hubspot.com/allen'), 'SCHEDULER_LINK set: the booking link is in the HTML body');
  const noLink = pdfEmail.buildEmail({ blueprint, name: 'Maria Santos', to: SESSION.email, filename });
  ok(!noLink.html.includes('Book your consultation') && !/https?:\/\//.test(noLink.text), 'no SCHEDULER_LINK: no booking button is invented');
  ok(pdfEmail.subjectFor('{first_name}, your {vertical} blueprint', { first_name: 'Maria', vertical: 'Solar' }) === 'Maria, your Solar blueprint', 'PDF_EMAIL_SUBJECT supports the {first_name}/{vertical}/{tier}/{date} placeholders');
  ok(pdfEmail.safeLink('javascript:alert(1)') === '' && pdfEmail.safeLink('https://ok.example/x') === 'https://ok.example/x', 'only http(s) links are ever rendered into the email');
  const nasty = pdfEmail.buildEmail({ blueprint: Object.assign({}, blueprint, { meta: Object.assign({}, blueprint.meta, { verticalLabel: '<script>alert(1)</script>' }) }), name: 'A&B Corp', to: SESSION.email, filename });
  ok(!/<script/.test(nasty.html) && nasty.html.includes('&lt;script&gt;'), 'blueprint text is HTML-escaped in the body');
  ok(nasty.html.includes('Hi A&amp;B,') && !/Hi A&B,/.test(nasty.html), 'the greeting escapes the name it is given');
  ok(pdfEmail.isEmail('maria@solarworks.ph') && !pdfEmail.isEmail('maria@solarworks') && !pdfEmail.isEmail(''), 'recipient validation is strict');

  section('a stubbed Resend success is reported as sent');
  await withEmailEnv(async () => {
    const stub = makeStub();
    const r = await pdfEmail.sendBlueprintEmail({ to: SESSION.email, name: SESSION.name, blueprint, filename, pdfBuffer, env: process.env, fetchImpl: stub.fetchImpl });
    ok(r.sent === true && r.id === 're_stub_1', 'sent:true with the Resend id the API returned');
    ok(pdfEmail.publicEmail(r).sent === true, 'the public shape keeps sent:true for the UI');
    const call = resendCalls(stub.calls)[0];
    ok(call && call.url === pdfEmail.RESEND_ENDPOINT && call.method === 'POST', 'the REST call is POST https://api.resend.com/emails');
    ok(call.headers.authorization === 'Bearer ' + PDF_KEY, 'the key travels in the Authorization header');
    ok(Array.isArray(call.body.to) && call.body.to[0] === SESSION.email, 'the recipient is the address that was handed in');
    ok(call.body.from === 'PipelineSync <blueprints@pipelinesync.ai>', 'the From header comes from PDF_EMAIL_FROM');
    ok(call.body.attachments && call.body.attachments.length === 1, 'exactly one attachment is sent');
    const att = call.body.attachments[0];
    ok(att.filename.endsWith('.pdf') && att.filename === filename, 'the attachment is named like the browser download (' + att.filename + ')');
    const decoded = Buffer.from(att.content, 'base64');
    ok(decoded.slice(0, 8).toString('latin1').startsWith('%PDF-1.4'), 'the attachment is the PDF itself, base64-encoded');
    ok(!!call.body.html && !!call.body.text && call.body.html.includes(filename), 'the email carries both the HTML body and a plain-text twin');
    ok(!/undefined/.test(call.body.html + call.body.text) && /background:#FFFFFF/.test(call.body.html), 'every style in the body resolved (no undefined token leaked into the HTML)');
    ok(!JSON.stringify(r).includes(PDF_KEY), 'the API key is never part of the result');
  });

  section('a stubbed Resend failure is reported as a failure, key intact');
  await withEmailEnv(async () => {
    const refuse = makeStub({ resend: { status: 422, body: { statusCode: 422, name: 'validation_error', message: 'The pipelinesync.ai domain is not verified. Verify the domain and try again.' } } });
    const r = await pdfEmail.sendBlueprintEmail({ to: SESSION.email, name: SESSION.name, blueprint, filename, pdfBuffer, env: process.env, fetchImpl: refuse.fetchImpl });
    ok(r.sent === false, 'sent:false when Resend refuses the message');
    ok(/domain is not verified/.test(r.error), 'the reason Resend gave is carried through: ' + JSON.stringify(r.error));
    ok(!JSON.stringify(r).includes(PDF_KEY), 'the API key is not in the error either');
    const down = makeStub({ resend: { throw: new Error('ECONNRESET') } });
    const r2 = await pdfEmail.sendBlueprintEmail({ to: SESSION.email, env: process.env, blueprint, filename, pdfBuffer, fetchImpl: down.fetchImpl });
    ok(r2.sent === false && /Could not reach Resend/.test(r2.error), 'a network error is sent:false, not an exception');
    const slow = makeStub({ resend: { status: 200, body: { id: 'late' }, delayMs: 400 } });
    const r3 = await pdfEmail.sendBlueprintEmail({ to: SESSION.email, env: process.env, blueprint, filename, pdfBuffer, fetchImpl: slow.fetchImpl, timeoutMs: 60 });
    ok(r3.sent === false && /did not respond/.test(r3.error), 'a hung Resend is cut off by the timeout rather than holding the function');
  });

  section('deliver: server-side blueprint only, jobId required');
  await withEmailEnv(async () => {
    try { jobs._resetMemory(); idempotency._resetMemory(); } catch (e) {}
    const jobId = await createTestJob(SESSION.email, fields, blueprint);
    const stub = makeStub();
    const out = await callDeliver(deliverBody(jobId), stub, '198.51.100.10');
    ok(out.statusCode === 200 && out.json.ok === true, 'deliver 200 with valid jobId');
    ok(out.json.email && out.json.email.sent === true, 'the response says email.sent:true (what the UI is allowed to show)');
    ok(out.json.email.to === SESSION.email, 'the reported recipient is the session address');
    ok(out.json.email.id === 're_stub_1', 'the reported Resend id is the one the stub returned');
    const pdf = Buffer.from(out.json.pdf_base64 || '', 'base64');
    ok(pdf.slice(0, 8).toString('latin1').startsWith('%PDF-1.4'), 'the PDF still comes back to the browser');
    ok(out.json.filename === filename, 'the filename matches the attachment');
    ok(resendCalls(stub.calls)[0].body.to[0] === SESSION.email, 'Resend was asked to mail the session address');
    ok(!JSON.stringify(out.json).includes(PDF_KEY), 'no key material in the API response');

    // Hand-made blueprint without valid jobId gets no PDF and no email
    const badStub = makeStub();
    const badOut = await callDeliver({ token, jobId: 'deadbeefdeadbeef', consent: true, blueprint: { meta: { verticalLabel: 'Fake' } } }, badStub, '198.51.100.11');
    ok(badOut.statusCode === 404, 'hand-made blueprint without valid jobId gets 404');
    ok(!badOut.json.pdf_base64, 'no PDF for invalid jobId');
    ok(resendCalls(badStub.calls).length === 0, 'no email for invalid jobId');

    // Different body.email changes nothing (token email everywhere)
    try { jobs._resetMemory(); idempotency._resetMemory(); } catch (e) {}
    const jobId2 = await createTestJob(SESSION.email, fields, blueprint);
    const redirect = makeStub();
    const out2 = await callDeliver(Object.assign(deliverBody(jobId2), { email: 'attacker@elsewhere.example' }), redirect, '198.51.100.12');
    const sent = resendCalls(redirect.calls)[0];
    ok(sent && sent.body.to[0] === SESSION.email && sent.body.to[0] !== 'attacker@elsewhere.example', 'token email everywhere: attacker body.email ignored, still sends to token email');
    ok(out2.json.email.to === SESSION.email, 'response reports token email even when body.email is attacker');
  });

  section('deliver: a Resend failure still returns the PDF');
  await withEmailEnv(async () => {
    try { jobs._resetMemory(); idempotency._resetMemory(); } catch (e) {}
    const jobId = await createTestJob(SESSION.email, fields, blueprint);
    const stub = makeStub({ resend: { status: 401, body: { statusCode: 401, name: 'missing_api_key', message: 'API key is invalid' } } });
    const out = await callDeliver(deliverBody(jobId), stub, '198.51.100.13');
    ok(out.statusCode === 200, 'the browser download is not blocked by the email failing');
    ok(out.json.email.sent === false && /API key is invalid/.test(out.json.email.error), 'the failure is reported with the reason');
    const pdf = Buffer.from(out.json.pdf_base64 || '', 'base64');
    ok(pdf.slice(0, 8).toString('latin1').startsWith('%PDF-1.4'), 'the PDF is still attached to the HTTP response');
    ok(out.json.ok === true && out.json.filename === filename, 'the rest of the deliver contract is unchanged');
  });

  section('the HubSpot note records the email result');
  try { require('../lib/deliver-limits')._resetMemory(); jobs._resetMemory(); idempotency._resetMemory(); } catch (e) {}
  ok(hubspot.emailNoteLine(null) === '', 'no attempt: no line is written to the note');
  ok(/^Email: sent to maria@solarworks\.ph \(Resend re_1\) with the PDF attached$/.test(hubspot.emailNoteLine({ sent: true, to: 'maria@solarworks.ph', id: 're_1' })), 'a confirmed send becomes a positive note line');
  ok(/^Email: NOT sent - boom$/.test(hubspot.emailNoteLine({ sent: false, error: 'boom' })), 'a failure becomes a NOT sent line');
  process.env.HUBSPOT_ACCESS_TOKEN = 'pat-na1-test-token-xxxxxxxx';
  try {
    await withEmailEnv(async () => {
      try { jobs._resetMemory(); idempotency._resetMemory(); } catch (e) {}
      const jobId = await createTestJob(SESSION.email, fields, blueprint);
      const good = makeStub();
      await callDeliver(deliverBody(jobId), good, '198.51.100.14');
      const note = noteCalls(good.calls)[0];
      const body = note && note.body && note.body.properties && note.body.properties.hs_note_body;
      ok(!!body, 'a note was created on the contact');
      ok(/Email: sent to maria@solarworks\.ph \(Resend re_stub_1\)/.test(body || ''), 'the note says the email went out, with the Resend id');

      try { jobs._resetMemory(); idempotency._resetMemory(); } catch (e) {}
      const jobId2 = await createTestJob(SESSION.email, fields, blueprint);
      const bad = makeStub({ resend: { status: 500, body: { message: 'Resend is having a bad day' } } });
      await callDeliver(deliverBody(jobId2), bad, '198.51.100.15');
      const note2 = noteCalls(bad.calls)[0];
      const body2 = note2 && note2.body && note2.body.properties && note2.body.properties.hs_note_body;
      ok(/Email: NOT sent - .*Resend is having a bad day/.test(body2 || ''), 'a failed send is written to the note as NOT sent');
    });
  } finally { delete process.env.HUBSPOT_ACCESS_TOKEN; }

  section('deliver is limited to 5 per minute per IP (the deployed function)');
  try { require('../lib/deliver-limits')._resetMemory(); jobs._resetMemory(); idempotency._resetMemory(); } catch (e) {}
  await withEmailEnv(async () => {
    const stub = makeStub({ resend: { status: 500, body: { message: 'nope' } } });
    const results = [];
    for (let i = 0; i < 6; i++) {
      try { jobs._resetMemory(); idempotency._resetMemory(); } catch (e) {}
      const jid = await createTestJob(SESSION.email, fields, blueprint);
      results.push(await callDeliver(deliverBody(jid), stub, '203.0.113.77'));
    }
    ok(results.slice(0, 5).every(r => r.statusCode === 200), 'the first five attempts in the minute are served');
    ok(results[5].statusCode === 429, 'the sixth is refused with 429');
    ok(/Too many unlock attempts/.test(results[5].json.error || ''), 'the 429 explains itself');
    ok(Number(results[5].headers['retry-after'] || results[5].headers['Retry-After']) > 0, 'the 429 carries Retry-After');
    ok(!results[5].json.pdf_base64, 'a refused attempt builds nothing and sends nothing');
    // Note: resendCalls counts 5 because 6th is blocked before email
    ok(resendCalls(stub.calls).length === 5, 'exactly five emails were attempted, never six');
    const otherJob = await createTestJob(SESSION.email, fields, blueprint);
    const other = await callDeliver(deliverBody(otherJob), stub, '203.0.113.78');
    ok(other.statusCode === 200, 'the limit is per IP, not global');
    process.env.DELIVER_RATE_PER_MIN = '1000';
    try { jobs._resetMemory(); idempotency._resetMemory(); } catch (e) {}
    const rolledJob = await createTestJob(SESSION.email, fields, blueprint);
    const rolled = await callDeliver(deliverBody(rolledJob), stub, '203.0.113.77');
    ok(rolled.statusCode === 200, 'DELIVER_RATE_PER_MIN overrides the default');
    delete process.env.DELIVER_RATE_PER_MIN;
  });

  section('idempotency: duplicate returns PDF with duplicate:true, no new deal/email');
  await withEmailEnv(async () => {
    try { jobs._resetMemory(); idempotency._resetMemory(); } catch (e) {}
    const jobId = await createTestJob(SESSION.email, fields, blueprint);
    const stub = makeStub();
    const first = await callDeliver(deliverBody(jobId), stub, '198.51.100.20');
    ok(first.statusCode === 200 && !first.json.duplicate, 'first delivery not duplicate');
    const dealIdFirst = first.json.hubspot && first.json.hubspot.dealId;
    const callsAfterFirst = stub.calls.length;
    const second = await callDeliver(deliverBody(jobId), stub, '198.51.100.20');
    ok(second.statusCode === 200 && second.json.duplicate === true, 'repeat returns duplicate:true');
    ok(!!second.json.pdf_base64, 'duplicate still returns PDF');
    ok(stub.calls.length === callsAfterFirst, 'duplicate does not create new deal or email');
    // resendEmail allows one extra send
    const third = await callDeliver(Object.assign(deliverBody(jobId), { resendEmail: true }), stub, '198.51.100.20');
    ok(third.statusCode === 200, 'resendEmail true allows extra send');
    ok(resendCalls(stub.calls).length === 2, 'resendEmail sent one extra email');
  });

  section('Supabase failure does not block PDF');
  await withEmailEnv(async () => {
    try { jobs._resetMemory(); idempotency._resetMemory(); } catch (e) {}
    const jobId = await createTestJob(SESSION.email, fields, blueprint);
    const stub = makeStub();
    // Mock Supabase failure by setting env to enable but making save fail? We test via direct deliver-core with mocked leads
    // For this test, we simulate by making leads.isEnabled true but saveBlueprint throws
    const origLeads = require('../lib/supabase-leads');
    const origSave = origLeads.saveBlueprint;
    const origUpdate = origLeads.updateLead;
    const origAdd = origLeads.addEvent;
    const origIsEnabled = origLeads.isEnabled;
    origLeads.isEnabled = () => true;
    origLeads.saveBlueprint = async () => { throw new Error('supabase down'); };
    origLeads.updateLead = async () => {};
    origLeads.addEvent = async () => {};
    const tokenWithLead = core.signToken({ email: SESSION.email, name: SESSION.name, lead_id: 'lead-123', exp: Date.now() + core.TOKEN_TTL_MS });
    const out = await callDeliver({ token: tokenWithLead, jobId, consent: true }, stub, '198.51.100.21');
    ok(out.statusCode === 200, 'Supabase failure returns 200, not 503');
    ok(out.json.persistence && out.json.persistence.ok === false, 'persistence:{ok:false} included');
    ok(!!out.json.pdf_base64, 'PDF still returned on Supabase failure');
    origLeads.saveBlueprint = origSave;
    origLeads.updateLead = origUpdate;
    origLeads.addEvent = origAdd;
    origLeads.isEnabled = origIsEnabled;
  });

  section('the local dev server mounts the same deliver path (jobId)');
  const srv = await startServer(8097, { DELIVER_RATE_PER_MIN: '5', PS_TOKEN_SECRET: TEST_SECRET, EMAIL_VERIFY: 'false' });
  try {
    const post = async (body) => {
      const r = await fetch(srv.base + '/api/deliver', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
      return { code: r.status, headers: r.headers, j: await r.json().catch(() => ({})) };
    };
    // Need to create job via API then deliver
    const login = await (await fetch(srv.base + '/api/auth/start', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: SESSION.name, email: SESSION.email }) })).json();
    const tok = login.token;
    const ex = await (await fetch(srv.base + '/api/extract', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ token: tok, answers }) })).json();
    const genStart = await (await fetch(srv.base + '/api/generate', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ token: tok, fields: ex.fields }) })).json();
    let jid = genStart.jobId;
    for (let i = 0; i < 30; i++) {
      await new Promise(r => setTimeout(r, 100));
      const st = await (await fetch(srv.base + '/api/generate/status?jobId=' + jid + '&token=' + encodeURIComponent(tok))).json();
      if (st.status === 'done') { jid = st.jobId; break; }
    }
    const first = await post({ token: tok, jobId: jid, consent: true, voice_meta: { provider: 'simulated', mode: 'simulated', turns: 12, questions_asked: ['what do you sell'], audio_retained: false } });
    ok(first.code === 200, 'a local deliver is served via jobId');
    ok(first.j.email && first.j.email.sent === false, 'with no Resend key configured the local server reports sent:false');
    ok(/PDF_EMAIL_API_KEY is not set/.test(first.j.email.error || ''), 'and says why, instead of claiming the PDF was emailed');
    ok(!!first.j.pdf_base64 && first.j.filename.endsWith('.pdf'), 'the local PDF download works exactly as before');
    // Rate limit
    for (let i = 0; i < 4; i++) {
      // Need new job each time because idempotency would return duplicate otherwise
      const ex2 = await (await fetch(srv.base + '/api/extract', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ token: tok, answers }) })).json();
      const gen2 = await (await fetch(srv.base + '/api/generate', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ token: tok, fields: ex2.fields }) })).json();
      let jid2 = gen2.jobId;
      for (let k = 0; k < 20; k++) {
        await new Promise(r => setTimeout(r, 80));
        const st = await (await fetch(srv.base + '/api/generate/status?jobId=' + jid2 + '&token=' + encodeURIComponent(tok))).json();
        if (st.status === 'done') { jid2 = st.jobId; break; }
      }
      await post({ token: tok, jobId: jid2, consent: true });
    }
    // 6th should be rate limited (same IP)
    const ex6 = await (await fetch(srv.base + '/api/extract', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ token: tok, answers }) })).json();
    const gen6 = await (await fetch(srv.base + '/api/generate', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ token: tok, fields: ex6.fields }) })).json();
    let jid6 = gen6.jobId;
    for (let k = 0; k < 20; k++) {
      await new Promise(r => setTimeout(r, 80));
      const st = await (await fetch(srv.base + '/api/generate/status?jobId=' + jid6 + '&token=' + encodeURIComponent(tok))).json();
      if (st.status === 'done') { jid6 = st.jobId; break; }
    }
    const sixth = await post({ token: tok, jobId: jid6, consent: true });
    ok(sixth.code === 429 && Number(sixth.headers.get('retry-after')) > 0, 'the dev server enforces the same 5/minute limit');

    const outbox = await (await fetch(srv.base + '/dev/outbox')).text();
    const decoded = outbox.replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
    ok(/"pdf_email"/.test(decoded) && /"sent": false/.test(decoded), 'the dev outbox records the email truth alongside the push');
    ok(/"voice_call"/.test(decoded) && /"audio_retained": false/.test(decoded), 'the voice-call metadata the outbox already carried is untouched');
  } finally {
    srv.stop();
  }

  console.log('\n' + (failures === 0 ? 'PDF EMAIL TESTS PASSED' : failures + ' FAILURE(S)'));
  process.exit(failures === 0 ? 0 : 1);
})().catch(e => { console.error('PDF email test error:', e); process.exit(1); });
