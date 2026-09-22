/* Phase 3 — email delivery of the PDF (lib/pdf-email.js + lib/deliver-core.js).
 *
 * What this proves, without ever touching Resend:
 *   1. the email is built from the blueprint and the session: greeting, 2-3 grounded sentences,
 *      "your blueprint is attached", and the booking link only when SCHEDULER_LINK is set;
 *   2. a stubbed Resend success is reported as sent:true, with the PDF attached as base64;
 *   3. a stubbed Resend failure is reported as sent:false WITH the reason, and the PDF is still
 *      returned to the browser (email failure never blocks the download);
 *   4. the recipient is the address in the HMAC-signed token, never the request body - a body
 *      that names somebody else's address does not redirect the attachment;
 *   5. the HubSpot note records what the email did;
 *   6. /api/deliver is limited to 5 unlocks per minute per IP on both mounts.
 *
 * Both mounts are covered: the Netlify function handler (in-process, stubbed fetch) and the
 * local dev server over HTTP (test/harness.js starts it; no Resend key is present there, so the
 * response must say the email was not sent instead of pretending otherwise).
 */
const core = require('../lib/core');
const hubspot = require('../lib/hubspot');
const pdfEmail = require('../lib/pdf-email');
const deliverFn = require('../netlify/functions/deliver.js').handler;
const { startServer } = require('./harness');

// The in-process function calls and the spawned test server must sign with the same secret
// (long enough that core does not warn about it).
const TEST_SECRET = 'test-secret-0123456789abcdef';
process.env.PS_TOKEN_SECRET = TEST_SECRET;

/* The mock lead payload is a large one-line JSON blob; this file prints its own results only. */
const realLog = console.log.bind(console);
const realWarn = console.warn.bind(console);
const hush = (...args) => !/^\[(hubspot-mock|hubspot|security)\]/.test(String(args[0] || ''));
console.log = (...args) => { if (hush(...args)) realLog(...args); };
console.warn = (...args) => { if (hush(...args)) realWarn(...args); };

const sleep = ms => new Promise(r => setTimeout(r, ms));
let failures = 0;
const ok = (cond, msg) => { console.log((cond ? '  PASS  ' : '  FAIL  ') + msg); if (!cond) failures++; };
const section = t => console.log('\n' + t);

/* A real blueprint from a real persona, so the email is built from the same shape the app sends. */
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

/* ---- stubs -------------------------------------------------------- */

function stubRes(status, body, headers) {
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

/* One fetch stub for both providers: api.resend.com follows `resend`, api.hubapi.com is a
   minimal HubSpot CRM (contact search miss, contact create, deal create, associations, note).
   The Resend branch honours init.signal, so the timeout path can be exercised for real. */
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

/* Call the deliver function with a stubbed network, then put global fetch back. */
async function callDeliver(body, stub, ip) {
  const orig = globalThis.fetch;
  globalThis.fetch = stub ? stub.fetchImpl : orig;
  try {
    const event = {
      httpMethod: 'POST', path: '/api/deliver',
      headers: ip ? { 'x-nf-client-connection-ip': ip } : {},
      body: JSON.stringify(body)
    };
    // The handler reads globalThis.fetch itself; this covers the convention both mounts use.
    const res = await deliverFn(event);
    return { statusCode: res.statusCode, headers: res.headers, json: JSON.parse(res.body || '{}') };
  } finally {
    globalThis.fetch = orig;
  }
}

const deliverBody = extra => Object.assign({
  token, email: SESSION.email, consent: true, fields, blueprint
}, extra || {});

const MAIL_ENV = ['PDF_EMAIL_API_KEY', 'PDF_EMAIL_FROM', 'PDF_EMAIL_SUBJECT', 'PDF_EMAIL_REPLY_TO', 'SCHEDULER_LINK'];

/* Configure the environment for one block, then put it back exactly as it was. */
function withEmailEnv(fn) {
  const saved = {};
  for (const k of MAIL_ENV) saved[k] = process.env[k];
  process.env.PDF_EMAIL_API_KEY = PDF_KEY;
  process.env.PDF_EMAIL_FROM = 'PipelineSync <blueprints@pipelinesync.ai>';
  for (const k of ['PDF_EMAIL_SUBJECT', 'PDF_EMAIL_REPLY_TO', 'SCHEDULER_LINK']) delete process.env[k];
  return Promise.resolve()
    .then(fn)
    .finally(() => {
      for (const k of MAIL_ENV) {
        if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k];
      }
    });
}

(async () => {
  // Nothing below may reach a real provider.
  delete process.env.HUBSPOT_ACCESS_TOKEN;
  delete process.env.PDF_EMAIL_API_KEY;
  delete process.env.PDF_EMAIL_FROM;
  delete process.env.DELIVER_RATE_PER_MIN;

  /* ------------------------------------------------------------------ */
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

  /* ------------------------------------------------------------------ */
  section('the email body is built from the blueprint and the session');
  const mail = pdfEmail.buildEmail({
    blueprint, name: 'Maria Santos', to: SESSION.email, filename,
    schedulerLink: 'https://meetings.hubspot.com/allen'
  });
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
  ok(pdfEmail.subjectFor('{first_name}, your {vertical} blueprint', { first_name: 'Maria', vertical: 'Solar' }) === 'Maria, your Solar blueprint',
    'PDF_EMAIL_SUBJECT supports the {first_name}/{vertical}/{tier}/{date} placeholders');
  ok(pdfEmail.safeLink('javascript:alert(1)') === '' && pdfEmail.safeLink('https://ok.example/x') === 'https://ok.example/x',
    'only http(s) links are ever rendered into the email');
  const nasty = pdfEmail.buildEmail({
    blueprint: Object.assign({}, blueprint, { meta: Object.assign({}, blueprint.meta, { verticalLabel: '<script>alert(1)</script>' }) }),
    name: 'A&B Corp', to: SESSION.email, filename
  });
  ok(!/<script/.test(nasty.html) && nasty.html.includes('&lt;script&gt;'), 'blueprint text is HTML-escaped in the body');
  ok(nasty.html.includes('Hi A&amp;B,') && !/Hi A&B,/.test(nasty.html), 'the greeting escapes the name it is given');
  ok(pdfEmail.isEmail('maria@solarworks.ph') && !pdfEmail.isEmail('maria@solarworks') && !pdfEmail.isEmail(''), 'recipient validation is strict');

  /* ------------------------------------------------------------------ */
  section('a stubbed Resend success is reported as sent');
  await withEmailEnv(async () => {
    const stub = makeStub();
    const r = await pdfEmail.sendBlueprintEmail({
      to: SESSION.email, name: SESSION.name, blueprint, filename, pdfBuffer,
      env: process.env, fetchImpl: stub.fetchImpl
    });
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
    ok(!/undefined/.test(call.body.html + call.body.text) && /background:#FFFFFF/.test(call.body.html),
      'every style in the body resolved (no undefined token leaked into the HTML)');
    ok(!JSON.stringify(r).includes(PDF_KEY), 'the API key is never part of the result');
  });

  /* ------------------------------------------------------------------ */
  section('a stubbed Resend failure is reported as a failure, key intact');
  await withEmailEnv(async () => {
    const refuse = makeStub({ resend: { status: 422, body: { statusCode: 422, name: 'validation_error', message: 'The pipelinesync.ai domain is not verified. Verify the domain and try again.' } } });
    const r = await pdfEmail.sendBlueprintEmail({
      to: SESSION.email, name: SESSION.name, blueprint, filename, pdfBuffer,
      env: process.env, fetchImpl: refuse.fetchImpl
    });
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

  /* ------------------------------------------------------------------ */
  section('deliver: stubbed Resend success, recipient taken from the signed token');
  await withEmailEnv(async () => {
    const stub = makeStub();
    const out = await callDeliver(deliverBody(), stub, '198.51.100.10');
    ok(out.statusCode === 200 && out.json.ok === true, 'deliver 200');
    ok(out.json.email && out.json.email.sent === true, 'the response says email.sent:true (what the UI is allowed to show)');
    ok(out.json.email.to === SESSION.email, 'the reported recipient is the session address');
    ok(out.json.email.id === 're_stub_1', 'the reported Resend id is the one the stub returned');
    const pdf = Buffer.from(out.json.pdf_base64 || '', 'base64');
    ok(pdf.slice(0, 8).toString('latin1').startsWith('%PDF-1.4'), 'the PDF still comes back to the browser');
    ok(out.json.filename === filename, 'the filename matches the attachment');
    ok(resendCalls(stub.calls)[0].body.to[0] === SESSION.email, 'Resend was asked to mail the session address');
    ok(!JSON.stringify(out.json).includes(PDF_KEY), 'no key material in the API response');

    // The body cannot redirect the attachment: the typed address is only ever the CRM/display one.
    const redirect = makeStub();
    const out2 = await callDeliver(deliverBody({ email: 'attacker@elsewhere.example' }), redirect, '198.51.100.11');
    const sent = resendCalls(redirect.calls)[0];
    ok(sent && sent.body.to[0] === SESSION.email && sent.body.to[0] !== 'attacker@elsewhere.example',
      'the recipient stays the verified token address even when the request body names another one');
    ok(out2.json.email.to === SESSION.email, 'the response reports the address it really emailed');
  });

  /* ------------------------------------------------------------------ */
  section('deliver: a Resend failure still returns the PDF');
  await withEmailEnv(async () => {
    const stub = makeStub({ resend: { status: 401, body: { statusCode: 401, name: 'missing_api_key', message: 'API key is invalid' } } });
    const out = await callDeliver(deliverBody(), stub, '198.51.100.12');
    ok(out.statusCode === 200, 'the browser download is not blocked by the email failing');
    ok(out.json.email.sent === false && /API key is invalid/.test(out.json.email.error), 'the failure is reported with the reason');
    const pdf = Buffer.from(out.json.pdf_base64 || '', 'base64');
    ok(pdf.slice(0, 8).toString('latin1').startsWith('%PDF-1.4'), 'the PDF is still attached to the HTTP response');
    ok(out.json.ok === true && out.json.filename === filename, 'the rest of the deliver contract is unchanged');
  });

  /* ------------------------------------------------------------------ */
  section('the HubSpot note records the email result');
  ok(hubspot.emailNoteLine(null) === '', 'no attempt: no line is written to the note');
  ok(/^Email: sent to maria@solarworks\.ph \(Resend re_1\) with the PDF attached$/.test(hubspot.emailNoteLine({ sent: true, to: 'maria@solarworks.ph', id: 're_1' })),
    'a confirmed send becomes a positive note line');
  ok(/^Email: NOT sent - boom$/.test(hubspot.emailNoteLine({ sent: false, error: 'boom' })), 'a failure becomes a NOT sent line');
  process.env.HUBSPOT_ACCESS_TOKEN = 'pat-na1-test-token-xxxxxxxx';
  try {
    await withEmailEnv(async () => {
      const good = makeStub();
      await callDeliver(deliverBody(), good, '198.51.100.13');
      const note = noteCalls(good.calls)[0];
      const body = note && note.body && note.body.properties && note.body.properties.hs_note_body;
      ok(!!body, 'a note was created on the contact');
      ok(/Email: sent to maria@solarworks\.ph \(Resend re_stub_1\)/.test(body || ''), 'the note says the email went out, with the Resend id');

      const bad = makeStub({ resend: { status: 500, body: { message: 'Resend is having a bad day' } } });
      await callDeliver(deliverBody(), bad, '198.51.100.14');
      const note2 = noteCalls(bad.calls)[0];
      const body2 = note2 && note2.body && note2.body.properties && note2.body.properties.hs_note_body;
      ok(/Email: NOT sent - .*Resend is having a bad day/.test(body2 || ''), 'a failed send is written to the note as NOT sent');
    });
  } finally {
    delete process.env.HUBSPOT_ACCESS_TOKEN;
  }

  /* ------------------------------------------------------------------ */
  section('deliver is limited to 5 per minute per IP (the deployed function)');
  await withEmailEnv(async () => {
    const stub = makeStub({ resend: { status: 500, body: { message: 'nope' } } });
    const results = [];
    for (let i = 0; i < 6; i++) results.push(await callDeliver(deliverBody(), stub, '203.0.113.77'));
    ok(results.slice(0, 5).every(r => r.statusCode === 200), 'the first five attempts in the minute are served');
    ok(results[5].statusCode === 429, 'the sixth is refused with 429');
    ok(/Too many unlock attempts/.test(results[5].json.error || ''), 'the 429 explains itself');
    ok(Number(results[5].headers['retry-after'] || results[5].headers['Retry-After']) > 0, 'the 429 carries Retry-After');
    ok(!results[5].json.pdf_base64, 'a refused attempt builds nothing and sends nothing');
    ok(resendCalls(stub.calls).length === 5, 'exactly five emails were attempted, never six');
    // A different IP is unaffected.
    const other = await callDeliver(deliverBody(), stub, '203.0.113.78');
    ok(other.statusCode === 200, 'the limit is per IP, not global');
    // And the override exists for the suite (test/harness.js sets it high).
    process.env.DELIVER_RATE_PER_MIN = '1000';
    const rolled = await callDeliver(deliverBody(), stub, '203.0.113.77');
    ok(rolled.statusCode === 200, 'DELIVER_RATE_PER_MIN overrides the default');
    delete process.env.DELIVER_RATE_PER_MIN;
  });

  /* ------------------------------------------------------------------ */
  section('the local dev server mounts the same deliver path');
  const srv = await startServer(8097, { DELIVER_RATE_PER_MIN: '5', PS_TOKEN_SECRET: TEST_SECRET });
  try {
    const post = async (body) => {
      const r = await fetch(srv.base + '/api/deliver', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
      return { code: r.status, headers: r.headers, j: await r.json().catch(() => ({})) };
    };
    const first = await post(deliverBody({
      voice_meta: { provider: 'simulated', mode: 'simulated', turns: 12, questions_asked: ['what do you sell'], audio_retained: false }
    }));
    ok(first.code === 200, 'a local deliver is served');
    ok(first.j.email && first.j.email.sent === false, 'with no Resend key configured the local server reports sent:false');
    ok(/PDF_EMAIL_API_KEY is not set/.test(first.j.email.error || ''), 'and says why, instead of claiming the PDF was emailed');
    ok(!!first.j.pdf_base64 && first.j.filename === filename, 'the local PDF download works exactly as before');
    for (let i = 0; i < 4; i++) await post(deliverBody());
    const sixth = await post(deliverBody());
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
