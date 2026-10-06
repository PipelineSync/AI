'use strict';
/* Zero-touch delivery (AUTO_DELIVER, lib/autopilot.js).
 *
 * The journey under test: name + email, the AI voice call, then the Anthropic-built blueprint as a
 * PDF - with nothing to click in between, and nothing invented when the call did not get a figure.
 *
 * What this proves:
 *   A. the switch itself: default on, explicit off, junk values
 *   B. the AI's closing lines match the journey (no promise of a review screen that does not exist)
 *   C. /api/config reports the mode, so the browser cannot guess it
 *   D. the automatic first delivery goes out with EMAIL_VERIFY on and no code - and only the FIRST:
 *      a repeat call returns the same PDF without a second email
 *   E. consent is still required, and the CRM note records the moment the visitor actually agreed
 *   F. with AUTO_DELIVER=false nothing changes: the code step is back in front of the send
 *   G. end to end over HTTP: gate -> extract -> generate -> deliver, email actually sent (to a
 *      local Resend stub via PDF_EMAIL_ENDPOINT), plus the guardrail that a missing required
 *      figure is never invented
 *   H. the browser: the journey lands on the delivered blueprint with zero clicks
 */

const http = require('http');
const fs = require('fs');
const path = require('path');
const { JSDOM } = require('jsdom');

const core = require('../lib/core');
const autopilot = require('../lib/autopilot');
const voice = require('../lib/voice');
const jobs = require('../lib/job-store');
const deliverFn = require('../netlify/functions/deliver.js').handler;
const { startServer } = require('./harness');

const TEST_SECRET = 'test-secret-0123456789abcdef';
process.env.PS_TOKEN_SECRET = TEST_SECRET;

const realLog = console.log.bind(console);
const realWarn = console.warn.bind(console);
const hush = (...args) => !/^\[(hubspot-mock|hubspot|security|email|deliver)\b/.test(String(args[0] || ''));
console.log = (...args) => { if (hush(...args)) realLog(...args); };
console.warn = (...args) => { if (hush(...args)) realWarn(...args); };

let failures = 0;
const ok = (cond, msg) => { console.log((cond ? '  PASS  ' : '  FAIL  ') + msg); if (!cond) failures++; };
const section = t => console.log('\n' + t);
const sleep = ms => new Promise(r => setTimeout(r, ms));

const persona = require('./personas.json').solar;
const answers = Object.entries(persona.answers).map(([id, text]) => ({ id, text }));
const fields = core.extract(answers);
const blueprint = core.generate(fields);
const SESSION = { email: 'maria@solarworks.ph', name: 'Maria Santos' };
const token = core.signToken({
  email: SESSION.email, name: SESSION.name, lead_id: null, hubspot_contact_id: null,
  exp: Date.now() + core.TOKEN_TTL_MS
});

/* ------------------------------------------------------------------ */
/* A local Resend: proves a real send without a real Resend account.   */
/* ------------------------------------------------------------------ */
let resendServer = null;
let resendPort = 0;
let resendCalls = [];
async function startResendStub() {
  resendServer = http.createServer((req, res) => {
    let body = '';
    req.on('data', d => { body += d; });
    req.on('end', () => {
      let parsed = null;
      try { parsed = JSON.parse(body || '{}'); } catch (e) {}
      resendCalls.push({ auth: req.headers.authorization || '', to: (parsed && parsed.to) || null, subject: (parsed && parsed.subject) || null, attachments: ((parsed && parsed.attachments) || []).length });
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ id: 're_zero_touch_' + resendCalls.length }));
    });
  });
  await new Promise(r => resendServer.listen(0, '127.0.0.1', r));
  resendPort = resendServer.address().port;
  return 'http://127.0.0.1:' + resendPort + '/emails';
}
function stopResendStub() { try { resendServer.close(); } catch (e) {} }

/* ------------------------------------------------------------------ */
/* The deliver path, called the way the function does (stubbed fetch). */
/* ------------------------------------------------------------------ */
async function createJob(email, f, bp) {
  const jobId = jobs.newJobId();
  await jobs.put(jobId, {
    status: 'done', step: 'done', label: 'Blueprint ready', progress: 100,
    source: 'fallback', blueprint: bp || blueprint,
    email: (email || SESSION.email).toLowerCase(), leadId: null, lead_id: null,
    fields: f || fields
  }, { env: process.env });
  return jobId;
}
function stubFetch(plan) {
  return async (url) => {
    const u = String(url);
    if (u.indexOf('api.resend.com') >= 0 || /\/emails$/.test(u)) {
      const r = (plan && plan.resend) || { id: 're_stub_1' };
      return { ok: true, status: 200, headers: { get: () => null }, json: async () => r, text: async () => JSON.stringify(r) };
    }
    if (u.indexOf('api.hubapi.com') >= 0) {
      return { ok: true, status: 200, headers: { get: () => null }, json: async () => ({ id: '1', results: [] }), text: async () => '{}' };
    }
    return { ok: false, status: 404, headers: { get: () => null }, json: async () => ({ message: 'not stubbed ' + u }), text: async () => '{}' };
  };
}
async function callDeliver(body, opts) {
  const o = opts || {};
  const orig = globalThis.fetch;
  globalThis.fetch = stubFetch(o.resend);
  try {
    const event = {
      httpMethod: 'POST', path: '/api/deliver',
      headers: o.ip ? { 'x-nf-client-connection-ip': o.ip } : {},
      body: JSON.stringify(body)
    };
    const res = await deliverFn(event);
    return { statusCode: res.statusCode, json: JSON.parse(res.body || '{}') };
  } finally {
    globalThis.fetch = orig;
  }
}

/* ------------------------------------------------------------------ */
/* The browser journey, driven in jsdom against a real server.         */
/* ------------------------------------------------------------------ */
const html = fs.readFileSync(path.join(__dirname, '..', 'public', 'index.html'), 'utf8')
  .replace(/<script src="app.js"><\/script>/, '');
const appJs = fs.readFileSync(path.join(__dirname, '..', 'public', 'app.js'), 'utf8');
const brandJs = ['Logo.js', 'Nova.js'].map(f =>
  fs.readFileSync(path.join(__dirname, '..', 'public', 'components', 'brand', f), 'utf8'));

const SOLAR = {
  business: 'We install residential and commercial solar systems for homeowners and small businesses in Ilocos.',
  products: 'Residential install at 1,200,000 pesos\nCommercial install at 4,500,000 pesos, and commercial needs a site survey first',
  deal: 'About 1,500,000 a deal, and three reps take calls',
  fulfilment: 'Six people, and our own crew does the installs',
  owner: 'It is me, with one operations assistant',
  close: 'Two calls. First we qualify and do the survey, then we present the proposal',
  sources: 'Google Ads about 25 a month, tracked\nFacebook about 18 a month, tracked\nWalk-ins about 10 a month, not tracked',
  capture: 'They land in a spreadsheet, and I use HubSpot Starter plus WhatsApp and Excel',
  volumes: '55 leads a month, I close 12, so about 22 percent, and three weeks from first call to signed',
  spend: '80,000 on ads, about 15,000 on software',
  headache: 'Follow-ups slip and I have no visibility on who is where in the process',
  goal: '20 closed installs a month'
};
const QMAP = [
  ['who do you sell to', 'business'], ['what do they cost', 'products'], ['how big is a typical deal', 'deal'],
  ['how many people handle fulfilment', 'fulfilment'], ['who owns marketing', 'owner'], ['how do most customers buy', 'close'],
  ['where do your leads come from', 'sources'], ['how do you capture leads', 'capture'],
  ['how many leads do you get a month', 'volumes'], ['what do you spend per month', 'spend'],
  ['biggest headache', 'headache'], ['six months from now', 'goal']
];
function boot(base) {
  const dom = new JSDOM(html, { url: base + '/', runScripts: 'outside-only', pretendToBeVisual: true });
  const { window } = dom;
  const { document } = window;
  const errors = [];
  let recognitionStarts = 0;
  window.fetch = (p, o) => fetch(new URL(p, base).toString(), o);
  window.addEventListener('error', e => { errors.push(e.message); });
  window.__PS_VOICE_TIMING__ = { silenceMs: 50, noSpeechMs: 400, maxListenMs: 1500, speakFactorMs: 4, minSpeakMs: 10, maxSpeakMs: 120 };
  window.SpeechSynthesisUtterance = class { constructor(text) { this.text = text; } };
  window.speechSynthesis = {
    getVoices() { return [{}]; },
    speak(u) { setTimeout(() => { if (u.onend) u.onend(); }, 5); },
    cancel() {}
  };
  window.Audio = class {
    constructor() { }
    play() { setTimeout(() => { if (this.onended) this.onended(); }, 5); return Promise.resolve(); }
    pause() {}
  };
  let lastKey = 'business';
  const answerNow = () => {
    const line = ((document.getElementById('ai-line') || {}).textContent || '').toLowerCase();
    for (const [frag, key] of QMAP) if (line.includes(frag)) { lastKey = key; break; }
    return SOLAR[lastKey];
  };
  window.SpeechRecognition = class {
    constructor() { this.lang = ''; this.interimResults = false; this.continuous = false; }
    start() {
      recognitionStarts++;
      const self = this;
      setTimeout(() => {
        if (self.onresult) self.onresult({ resultIndex: 0, results: [Object.assign([{ transcript: answerNow() + ' ' }], { isFinal: true })] });
        setTimeout(() => { if (self.onend) self.onend(); }, 20);
      }, 30);
    }
    stop() { if (this.onend) this.onend(); }
  };
  brandJs.forEach(src => window.eval(src));
  window.eval(appJs);
  return { window, document, errors, recognitionStarts: () => recognitionStarts };
}

(async () => {
  /* ---------------------------------------------------------------- */
  section('A. the switch (lib/autopilot.js)');
  ok(autopilot.isEnabled({}) === true, 'AUTO_DELIVER unset means zero-touch is on (the product default)');
  ok(autopilot.isEnabled({ AUTO_DELIVER: 'true' }) === true, 'AUTO_DELIVER=true is on');
  ok(autopilot.isEnabled({ AUTO_DELIVER: '1' }) === true, 'AUTO_DELIVER=1 is on');
  ok(autopilot.isEnabled({ AUTO_DELIVER: 'false' }) === false, 'AUTO_DELIVER=false is off');
  ok(autopilot.isEnabled({ AUTO_DELIVER: '0' }) === false, 'AUTO_DELIVER=0 is off');
  ok(autopilot.isEnabled({ AUTO_DELIVER: 'off' }) === false, 'AUTO_DELIVER=off is off');
  ok(autopilot.isEnabled({ AUTO_DELIVER: 'banana' }) === true, 'an unrecognised value falls back to the default');
  ok(/Zero-touch delivery: ON/.test(autopilot.startupNote({})), 'startup note says the mode out loud');
  ok(/AUTO_DELIVER=false/.test(autopilot.startupNote({})) && /EMAIL_VERIFY/.test(autopilot.startupNote({})),
    'startup note names the trade-off and the way back');
  ok(/Zero-touch delivery: off/.test(autopilot.startupNote({ AUTO_DELIVER: 'false' })), 'the off mode reports itself too');

  /* ---------------------------------------------------------------- */
  section("B. the AI's closing line matches the journey");
  const allAsked = voice.INTAKE_PLAN.map(q => q.id);
  const stateAll = { answers: [], asked: allAsked, probes: {}, skipped: [], voiceCaptures: [] };
  const manualCtx = { step: { question: { id: 'business', ask: 'What does your business do?', label: 'Business' }, kind: 'question', spoken: 'What does your business do?' }, asked: [], answers: [], probes: {}, skipped: [], capture: { status: {}, missingRequired: [] } };
  const autoCtx = Object.assign({}, manualCtx, { autoDeliver: true });
  const sysManual = voice.buildMessages(manualCtx).find(m => m.role === 'system').content;
  const sysAuto = voice.buildMessages(autoCtx).find(m => m.role === 'system').content;
  ok(/review and correct what was captured/.test(sysManual), 'step-by-step prompt: the manual closing line is unchanged when zero-touch is off');
  ok(/will reach their inbox as a PDF/.test(sysAuto), 'step-by-step prompt: zero-touch closes on the emailed PDF');
  ok(!/review and correct what was captured/.test(sysAuto), 'zero-touch never promises a review screen');
  const manualFaq = voice.faqAnswerFor('what happens after the call?', {}).say;
  const autoFaq = voice.faqAnswerFor('what happens after the call?', { autoDeliver: true }).say;
  ok(/review and correct/.test(manualFaq), 'FAQ "what happens after the call" stays manual when the switch is off');
  ok(/email it to you as a PDF/.test(autoFaq), 'FAQ answers with the automatic email in zero-touch');
  /* The guardrail is untouched: a missing required figure is still asked for, in both modes. */
  const cb = voice.nextStep(stateAll);
  ok(cb.kind === 'callback' && cb.field === 'typical_deal_size',
    'zero-touch does not skip the required figures: the deal-size callback still fires');

  /* ---------------------------------------------------------------- */
  section('C. /api/config reports the mode');
  const offSrv = await startServer(8101, { AUTO_DELIVER: 'false' });
  const offCfg = await (await fetch(offSrv.base + '/api/config')).json();
  ok(offCfg.autoDeliver === false, 'AUTO_DELIVER=false is reported to the browser as autoDeliver:false');
  offSrv.stop();

  const onSrv = await startServer(8102, { AUTO_DELIVER: 'true' });
  const onCfg = await (await fetch(onSrv.base + '/api/config')).json();
  ok(onCfg.autoDeliver === true, 'AUTO_DELIVER=true is reported as autoDeliver:true');

  /* ---------------------------------------------------------------- */
  section('D. the automatic first delivery, with EMAIL_VERIFY on and no code');
  const saved = {};
  ['PDF_EMAIL_API_KEY', 'PDF_EMAIL_FROM', 'EMAIL_VERIFY', 'DELIVER_PER_EMAIL_DAY', 'PDF_EMAIL_DAILY_MAX', 'DELIVER_RATE_PER_MIN', 'AUTO_DELIVER']
    .forEach(k => { saved[k] = process.env[k]; });
  process.env.PDF_EMAIL_API_KEY = 're_zero_touch_test';
  process.env.PDF_EMAIL_FROM = 'PipelineSync <blueprints@pipelinesync.ai>';
  process.env.EMAIL_VERIFY = 'true';          // the code step IS on - zero-touch must still deliver
  process.env.DELIVER_PER_EMAIL_DAY = '1000';
  process.env.PDF_EMAIL_DAILY_MAX = '1000';
  process.env.DELIVER_RATE_PER_MIN = '1000';
  process.env.AUTO_DELIVER = 'true';

  const jobId1 = await createJob();
  const auto1 = await callDeliver({ token, jobId: jobId1, consent: true, auto: true, consent_at: new Date(Date.now() - 60000).toISOString() });
  ok(auto1.statusCode === 200, 'auto delivery returns 200');
  ok(!!auto1.json.pdf_base64, 'the PDF comes back in the response');
  ok(!!auto1.json.email && auto1.json.email.sent === true, 'the email is sent even though EMAIL_VERIFY is on (no code step)');
  ok(auto1.json.email.to === SESSION.email, 'it goes to the address from the signed session');
  ok(auto1.json.duplicate !== true, 'the first delivery is not a duplicate');

  const auto2 = await callDeliver({ token, jobId: jobId1, consent: true, auto: true });
  ok(auto2.statusCode === 200 && auto2.json.duplicate === true, 'a repeat auto call returns the same PDF as a duplicate');
  ok(!!auto2.json.email && auto2.json.email.sent === true && auto2.json.email.id === auto1.json.email.id,
    'and does not send a second email (idempotency is untouched by zero-touch)');

  /* ---------------------------------------------------------------- */
  section('E. consent is still required, and recorded at the right moment');
  const jobId2 = await createJob();
  const noConsent = await callDeliver({ token, jobId: jobId2, consent: false, auto: true });
  ok(noConsent.statusCode === 400, 'auto delivery without consent is refused with 400');
  ok(/consent/i.test(noConsent.json.error || ''), 'and the error says consent is the reason');
  const withConsentAt = await callDeliver({ token, jobId: jobId2, consent: true, auto: true, consent_at: 'not-a-date' });
  ok(withConsentAt.statusCode === 200, 'an unparseable consent_at is ignored rather than failing the delivery');
  const consentNote = require('../lib/consent').buildConsentNoteLine('2026-10-07T02:00:00.000Z', 'v1-2026-09-28', null, 'entry gate (zero-touch delivery)');
  ok(/given at 2026-10-07T02:00:00.000Z/.test(consentNote) && /captured on entry gate \(zero-touch delivery\)/.test(consentNote),
    'the CRM consent line records when the visitor agreed and that it came from the entry gate');
  const manualNote = require('../lib/consent').buildConsentNoteLine('2026-10-07T02:00:00.000Z', 'v1-2026-09-28', null, 'PDF unlock screen');
  ok(/captured on PDF unlock screen/.test(manualNote), 'and the manual path names the unlock screen');

  /* ---------------------------------------------------------------- */
  section('F. AUTO_DELIVER=false keeps the manual, code-verified path');
  process.env.AUTO_DELIVER = 'false';
  const jobId3 = await createJob();
  const offAuto = await callDeliver({ token, jobId: jobId3, consent: true, auto: true });
  ok(offAuto.statusCode === 200 && !!offAuto.json.pdf_base64, 'the PDF still comes back (download is never gated)');
  ok(offAuto.json.email && offAuto.json.email.sent === false, 'but the email is NOT sent without a code');
  ok(/verification required/i.test((offAuto.json.email && offAuto.json.email.error) || ''), 'the reason is the email verification step');
  const manualNoAuto = await callDeliver({ token, jobId: jobId3, consent: true });
  ok(manualNoAuto.json.email && manualNoAuto.json.email.sent === false, 'and a manual call without a code is unchanged');

  /* ---------------------------------------------------------------- */
  section('G. end to end over HTTP, with a real send to a local Resend');
  const endpoint = await startResendStub();
  resendCalls = [];
  const procSeed = Object.assign({}, saved);
  const e2eSrv = await startServer(8103, {
    AUTO_DELIVER: 'true',
    EMAIL_VERIFY: 'true',           // so a code WOULD be required if zero-touch did not apply
    PDF_EMAIL_API_KEY: 're_zero_touch_e2e',
    PDF_EMAIL_FROM: 'PipelineSync <blueprints@pipelinesync.ai>',
    PDF_EMAIL_ENDPOINT: endpoint,
    DELIVER_PER_EMAIL_DAY: '1000',
    PDF_EMAIL_DAILY_MAX: '1000',
    DELIVER_RATE_PER_MIN: '1000'
  });
  const e2eCfg = await (await fetch(e2eSrv.base + '/api/config')).json();
  ok(e2eCfg.autoDeliver === true, 'the e2e server reports zero-touch');

  const started = await (await fetch(e2eSrv.base + '/api/auth/start', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: SESSION.name, email: SESSION.email })
  })).json();
  ok(!!started.token, 'the entry gate hands back a session token');
  const e2eToken = started.token;
  const extracted = await (await fetch(e2eSrv.base + '/api/extract', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ token: e2eToken, answers })
  })).json();
  ok(extracted.fields && extracted.fields.typical_deal_size === 1500000, 'Function A structures the call into the contract');
  const gen = await (await fetch(e2eSrv.base + '/api/generate', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ token: e2eToken, fields: extracted.fields })
  })).json();
  ok(!!gen.jobId, 'Function B accepts the job');
  let status = null;
  for (let i = 0; i < 100; i++) {
    status = await (await fetch(e2eSrv.base + '/api/generate/status?jobId=' + encodeURIComponent(gen.jobId) + '&token=' + encodeURIComponent(e2eToken))).json();
    if (status.status === 'done' || status.status === 'error') break;
    await sleep(50);
  }
  ok(status && status.status === 'done' && !!status.blueprint, 'the blueprint is built');
  const autoDeliver = await (await fetch(e2eSrv.base + '/api/deliver', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ token: e2eToken, jobId: gen.jobId, consent: true, auto: true, consent_at: new Date().toISOString() })
  })).json();
  ok(autoDeliver.ok === true && !!autoDeliver.pdf_base64, 'the automatic delivery returns the PDF');
  ok(autoDeliver.email && autoDeliver.email.sent === true, 'the email is sent end to end');
  ok(resendCalls.length === 1, 'exactly one email reached Resend');
  ok(resendCalls[0] && resendCalls[0].to && resendCalls[0].to[0] === SESSION.email, 'it went to the address from the entry gate');
  ok(resendCalls[0] && resendCalls[0].attachments === 1, 'with the PDF attached');
  const autoAgain = await (await fetch(e2eSrv.base + '/api/deliver', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ token: e2eToken, jobId: gen.jobId, consent: true, auto: true })
  })).json();
  ok(autoAgain.duplicate === true && resendCalls.length === 1, 'replaying the delivery sends no second email');

  /* The guardrail: a required figure the call never captured is refused, not invented. */
  const thin = Object.assign({}, extracted.fields, { close_rate: null });
  const thinGen = await (await fetch(e2eSrv.base + '/api/generate', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ token: e2eToken, fields: thin })
  })).json();
  ok(!thinGen.jobId && thinGen.fieldErrors && thinGen.fieldErrors.close_rate,
    'zero-touch never invents a missing required figure: the server refuses the job and names the field');
  e2eSrv.stop();

  /* ---------------------------------------------------------------- */
  section('H. the browser: call -> blueprint -> PDF, with no clicks');
  const uiSrv = await startServer(8104, {
    AUTO_DELIVER: 'true',
    EMAIL_VERIFY: 'false',
    PDF_EMAIL_API_KEY: 're_zero_touch_ui',
    PDF_EMAIL_FROM: 'PipelineSync <blueprints@pipelinesync.ai>',
    PDF_EMAIL_ENDPOINT: endpoint
  });
  const page = boot(uiSrv.base);
  const { document } = page;
  await sleep(250);
  // Entry gate
  document.getElementById('st-name').value = SESSION.name;
  document.getElementById('st-email').value = SESSION.email;
  document.getElementById('start-form').dispatchEvent(new page.window.Event('submit', { bubbles: true, cancelable: true }));
  await sleep(700);
  ok(!!document.querySelector('#consent-go'), 'the entry gate leads to the consent screen');
  ok(/emailed to/i.test(document.getElementById('consent-notice').textContent),
    'the consent notice says the PDF will be emailed when zero-touch is on');
  // Agree: the call starts and runs itself
  document.getElementById('consent-cb').click();
  document.getElementById('consent-go').click();
  await sleep(300);
  ok(!!document.querySelector('#mic-btn') || !!document.querySelector('#type-btn'), 'the call starts on agreement');
  ok((document.getElementById('structure-btn') || {}).textContent === undefined ||
    !document.getElementById('structure-btn'), 'the call is still running');
  let reviewSeen = false;
  for (let i = 0; i < 800; i++) {
    if (document.querySelector('#confirm-fields') || document.querySelector('#auto-needs-go')) reviewSeen = true;
    if (document.querySelector('.success-card') || document.querySelector('#redownload-btn')) break;
    await sleep(25);
  }
  ok(!!document.querySelector('#structure-btn') || !!document.querySelector('.doc'), 'the call closed itself when the intake set was covered');
  const structBtn = document.getElementById('structure-btn');
  ok(!structBtn || /Build my blueprint/i.test(structBtn.textContent), 'in zero-touch the call closes on "Build my blueprint", not "Review what we heard"');
  if (structBtn) structBtn.click();
  let delivered = false;
  for (let i = 0; i < 1200; i++) {
    if (document.querySelector('.success-card')) { delivered = true; break; }
    await sleep(25);
  }
  ok(delivered, 'the journey reached the delivered blueprint with no review screen and no unlock click');
  ok(!reviewSeen, 'the full review form never appeared');
  ok(!!document.querySelector('#redownload-btn'), 'the server PDF is on the screen');
  ok(/Delivered to/.test(document.body.textContent), 'and the screen says where it went');
  ok(page.errors.length === 0, 'no runtime errors' + (page.errors.length ? ': ' + page.errors[0] : ''));
  ok(resendCalls.length >= 2, 'the browser journey emailed the PDF through the real send path');
  uiSrv.stop();
  stopResendStub();

  /* ---------------------------------------------------------------- */
  Object.keys(saved).forEach(k => { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; });
  Object.keys(procSeed);
  onSrv.stop();

  console.log(failures ? '\nZERO-TOUCH TESTS FAILED (' + failures + ')' : '\nZERO-TOUCH TESTS PASSED');
  process.exit(failures ? 1 : 0);
})().catch(e => {
  console.error('zero-touch test crashed:', e && e.stack || e);
  process.exit(1);
});
