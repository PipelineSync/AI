/*
 * Voice layer tests: the interviewer policy, the capture state, the OpenAI adapters (stubbed),
 * and the four /api/voice routes against a running server in simulated mode.
 *
 * Run the server first:  node server.js
 * Then:                  node test/voice.js
 */
const BASE = 'http://127.0.0.1:8080';
const voice = require('../lib/voice');
const core = require('../lib/core');
const { clampVoiceMeta } = require('../lib/voice-api');

let failures = 0;
const ok = (cond, msg) => { console.log((cond ? '  PASS  ' : '  FAIL  ') + msg); if (!cond) failures++; };
const section = t => console.log('\n' + t);

const PLAN_ORDER = voice.INTAKE_PLAN.map(q => q.id);
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
const answersUpTo = n => PLAN_ORDER.slice(0, n).map(id => ({ id, text: SOLAR[id] || '' }));
const fullAnswers = () => PLAN_ORDER.map(id => ({ id, text: SOLAR[id] || '' }));
const fieldsFor = answers => core.extract(answers);

/* ------------------------------------------------------------------ */
function policyTests() {
  section('policy: what the interviewer asks next (deterministic guardrails)');
  const s1 = voice.nextStep({ answers: [], asked: [], probes: {} });
  ok(s1.question && s1.question.id === 'business' && s1.kind === 'opening', 'first turn opens with the business question');

  const asked = PLAN_ORDER.slice(0, 3);
  const s2 = voice.nextStep({ answers: answersUpTo(3), asked, probes: {} });
  ok(s2.question && s2.question.id === 'fulfilment', 'next unanswered question follows the plan order');

  // A thin answer (no figures) is probed straight after it, rather than moving on.
  const thin = [{ id: 'business', text: 'We sell solar.' }, { id: 'products', text: 'Panels and batteries.' }, { id: 'deal', text: 'It varies.' }];
  const s3 = voice.nextStep({ answers: thin, asked: ['business', 'products', 'deal'], probes: {} });
  ok(s3.kind === 'probe' && s3.question.id === 'deal', 'a thin answer is probed before moving on');
  ok(/how much is a typical deal/i.test(s3.spoken || ''), 'the probe asks for the missing figure');

  const s4 = voice.nextStep({ answers: thin, asked: ['business', 'products', 'deal'], probes: { deal: 1 } });
  ok(s4.question && s4.question.id === 'fulfilment', 'after one probe the call moves on');

  const noNumbers = PLAN_ORDER.map(id => ({ id, text: id === 'volumes' ? 'Lots, but I do not track them.' : 'stub' }));
  const s5 = voice.nextStep({ answers: noNumbers, asked: PLAN_ORDER, probes: {} });
  ok(s5.kind === 'callback' && !!s5.field, 'missing required figures are called back before the call ends');

  const s6 = voice.nextStep({ answers: noNumbers, asked: PLAN_ORDER, probes: {}, skipped: PLAN_ORDER });
  ok(s6.kind === 'done', 'skipped questions are never chased (the review screen fills the gaps)');

  const s7 = voice.nextStep({ answers: fullAnswers(), asked: PLAN_ORDER, probes: {} });
  ok(s7.kind === 'done' && s7.question === null, 'a complete call ends');
}

function captureTests() {
  section('capture: what the call has locked in');
  const c1 = voice.captureState(answersUpTo(9), []);
  ok(c1.status.typical_deal_size === 'captured' && c1.status.lead_sources === 'captured', 'captured fields are marked captured');
  ok(c1.missingRequired.length === 0, 'the three required fields are filled by the solar answers');

  const c2 = voice.captureState([{ id: 'business', text: 'We sell coffee online.' }], []);
  ok(c2.missingRequired.length === 3 && c2.status.typical_deal_size === 'missing', 'an early call still reports the three required fields as missing');
  ok(c2.filledCount < c2.totalCount, 'the filled count is below the contract size early on');

  const c3 = voice.captureState([{ id: 'business', text: 'We sell coffee online.' }], [{ field: 'monthly_lead_volume', value: '400', evidence: 'about 400 a month' }]);
  ok(c3.heard.monthly_lead_volume && c3.heard.monthly_lead_volume.value === '400', 'what the voice model says it heard is kept');
  ok(c3.disagreements.includes('monthly_lead_volume'), 'a heard value the parser missed is flagged as a disagreement');
}

function styleTests() {
  section('house style guard on anything the AI speaks');
  const s = voice.spokenStyle('Sure. **Great** - so what do you sell? \u2014 and to whom?');
  ok(!/\*\*/.test(s), 'markdown is stripped');
  ok(!/\u2014/.test(s), 'em dashes are replaced (house rule)');
  ok(voice.spokenStyle('x'.repeat(2000)).length <= voice.DEFAULTS.maxSayChars, 'spoken lines are capped');
}

async function adapterTests() {
  section('OpenAI adapters (stubbed fetch, no network)');
  const calls = [];
  const fakeJson = (obj, status) => Promise.resolve({
    ok: (status || 200) < 400, status: status || 200,
    text: () => Promise.resolve(JSON.stringify(obj)),
    arrayBuffer: () => Promise.resolve(new Uint8Array([1, 2, 3, 4]).buffer)
  });
  const env = { OPENAI_API_KEY: 'sk-test', PS_TOKEN_SECRET: 'test-secret' };
  const fetchImpl = (url, init) => {
    calls.push({ url, init });
    if (url.endsWith('/chat/completions')) {
      return fakeJson({ choices: [{ message: { content: JSON.stringify({ say: 'Got it. What is your biggest headache right now?', ask_question_id: 'headache', captured: [] }) } }], usage: { total_tokens: 42 } });
    }
    if (url.endsWith('/audio/speech')) return fakeJson({});
    if (url.endsWith('/audio/transcriptions')) return fakeJson({ text: 'About 55 leads a month.' });
    return fakeJson({}, 404);
  };

  const asked = PLAN_ORDER.slice(0, 10);
  const turn = await voice.runTurn({
    env, fetchImpl, email: 'owner@example.com',
    body: {
      answers: answersUpTo(10), asked, probes: {}, transcript: [], last_answer: 'Follow-ups slip.',
      voice_captures: [], call_id: 'call-test', with_audio: true
    }
  });
  const chatCall = calls.find(c => c.url.endsWith('/chat/completions'));
  const body = JSON.parse(chatCall.init.body);
  ok(body.response_format.type === 'json_schema' && body.response_format.json_schema.strict === true, 'the turn uses a strict JSON schema');
  ok(/One question per turn/.test(body.messages[0].content), 'the interviewer system prompt carries the guardrails');
  ok(/"assigned_question_id":"headache"/.test(body.messages[1].content), 'the guardrail question is handed to the model as the assigned one');
  ok(turn.say.startsWith('Got it.'), 'the model wording is what gets spoken');
  ok(!!turn.audio_base64 && turn.speak_with_browser === false, 'speech audio comes back with the turn');
  ok(turn.provider === 'openai' && turn.mode === 'openai', 'mode reports openai when the key is set');
  ok(!!turn.call_ticket, 'a signed call ticket comes back for the next turn');
  ok(turn.capture.totalCount === Object.keys(voice.FIELD_LABELS).length, 'the turn reports the full contract state');

  const fetchWrong = () => fakeJson({ choices: [{ message: { content: JSON.stringify({ say: 'Next one.', ask_question_id: 'goal', captured: [] }) } }] });
  const turn2 = await voice.runTurn({ env, fetchImpl: fetchWrong, email: 'owner@example.com', body: { answers: answersUpTo(10), asked, probes: {}, call_id: 'call-test', with_audio: false } });
  ok(turn2.ask.id === 'headache', 'the guardrail question wins over the model label');
  ok(turn2.warnings.some(w => /guardrail/.test(w)), 'the correction is reported as a warning');

  const fetch401 = () => fakeJson({ error: { message: 'Incorrect API key provided' } }, 401);
  const turn3 = await voice.runTurn({ env, fetchImpl: fetch401, email: 'owner@example.com', body: { answers: answersUpTo(10), asked, probes: {}, call_id: 'call-test', with_audio: false } });
  ok(!!turn3.say && turn3.ask.id === 'headache', 'a failing provider still produces the next line');
  ok(turn3.warnings.some(w => /OPENAI_API_KEY/.test(w)), 'the key problem is surfaced with a fixable message');

  const tr = await voice.transcribe({ apiKey: 'sk-test', model: voice.DEFAULTS.sttModel, fetchImpl, buffer: Buffer.from('audio'), mime: 'audio/webm' });
  ok(tr.text === 'About 55 leads a month.', 'transcription returns the text');

  const callsBefore = calls.length;
  let capErr = null;
  try {
    await voice.runTurn({
      env, fetchImpl, email: 'owner@example.com',
      body: {
        answers: fullAnswers(), asked: PLAN_ORDER, probes: {}, call_id: 'call-cap', with_audio: false,
        call_ticket: core.signToken({ email: 'owner@example.com', call_id: 'call-cap', turns: 999, kind: 'voice-call', exp: Date.now() + 10000 })
      }
    });
  } catch (e) { capErr = e; }
  ok(capErr && capErr.status === 429, 'the turn cap stops a runaway call');
  ok(calls.length === callsBefore, 'the cap is enforced before any provider call is made');
}

function noKeyTests() {
  section('no API key: the call still runs, on the built-in interviewer');
  const cfg = voice.mode({});
  ok(cfg.provider === 'simulated' && cfg.mode === 'simulated', 'simulated mode when the key is missing');
  ok(/OPENAI_API_KEY/.test(cfg.why), 'the reason names the missing key');
  const said = voice.simulatedSay({ step: voice.nextStep({ answers: [], asked: [], probes: {} }), asked: [], lastAnswer: null });
  ok(/PipelineSync/.test(said) && /Simulated voice/.test(said), 'the simulated opener explains itself');

  const forced = voice.mode({ OPENAI_API_KEY: 'sk-x', VOICE_PROVIDER: 'simulated' });
  ok(forced.mode === 'simulated', 'VOICE_PROVIDER=simulated forces the built-in interviewer even with a key');
}

function clampTests() {
  section('lead metadata clamp');
  const meta = clampVoiceMeta({
    provider: 'openai', mode: 'openai', models: { chat: 'gpt-4o-mini', tts: 'gpt-4o-mini-tts', stt: 'gpt-4o-transcribe' },
    tts_voice: 'alloy', call_id: 'call-1', started_at: '2026-01-01T00:00:00Z', ended_at: '2026-01-01T00:04:00Z',
    duration_s: 240, turns: 14, questions_asked: PLAN_ORDER, probes: 2,
    required_missing_at_call_end: [], transcript_turns: 28, audio_retained: true,
    secret: 'should not survive'
  });
  ok(meta.audio_retained === false, 'audio_retained is forced false');
  ok(meta.secret === undefined, 'unknown fields are dropped');
  ok(meta.turns === 14 && meta.duration_s === 240, 'known fields survive');
  ok(clampVoiceMeta(null) === null, 'empty metadata stays null');
}

async function httpTests() {
  section('HTTP routes (server must be running on ' + BASE + ')');
  let up = false;
  try { const r = await fetch(BASE + '/api/health'); up = r.ok; } catch (e) {}
  if (!up) {
    console.log('  (server not running: the HTTP block is skipped; start it with node server.js)');
    return;
  }
  const login = await (await fetch(BASE + '/api/auth/start', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: 'QA Tester', email: 'qa@pipelinesync.ai' }) })).json();
  const token = login.token;
  ok(!!token, 'entry gate returns a token for the route tests');
  ok(login.user && login.user.name === 'QA Tester', 'the entry gate keeps the name the client typed');
  const post = (p, b) => fetch(BASE + p, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(Object.assign({ token }, b)) });

  const unauth = await fetch(BASE + '/api/voice/session', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({}) });
  ok(unauth.status === 401, 'voice routes reject a request without a token');

  const sess = await (await post('/api/voice/session', {})).json();
  ok(sess.ok && sess.plan.length === 12, 'session returns the 12-question plan');
  ok(!!sess.plan[0].ask && !!sess.plan[0].hint, 'each plan item carries the question and the on-screen hint');
  ok(sess.required_fields.length === 3, 'session lists the three required fields');
  ok(sess.provider === 'simulated' || sess.provider === 'openai', 'session reports which provider is live');
  ok(sess.max_audio_bytes > 0, 'session tells the client the audio ceiling');

  // Drive a full call the way the browser does: answer whatever it asks, in order.
  let asked = [], probes = {}, turns = 0, ticket = null, lastLine = '', capture = null;
  for (let i = 0; i < 30; i++) {
    const qid = asked.length ? asked[asked.length - 1] : null;
    const res = await (await post('/api/voice/turn', {
      call_id: 'call-http', call_ticket: ticket, transcript: [],
      answers: asked.map(id => ({ id, text: SOLAR[id] || '' })),
      asked, probes, last_answer: qid ? SOLAR[qid] : null, with_audio: false, client_name: 'QA Tester'
    })).json();
    if (!res.ok) { ok(false, 'turn ' + i + ' failed: ' + res.error); break; }
    turns = res.turn; ticket = res.call_ticket; capture = res.capture; lastLine = res.say;
    if (!res.ask.id) break;
    if (res.ask.kind === 'probe' || res.ask.kind === 'callback') probes[res.ask.id] = (probes[res.ask.id] || 0) + 1;
    if (!asked.includes(res.ask.id)) asked.push(res.ask.id);
  }
  ok(turns >= 12 && turns <= 16, 'the call covered the 12 guardrail questions (' + turns + ' turns, probes included)');
  ok(lastLine.length > 0, 'the closing line is spoken');
  if (sess.mode === 'simulated') ok(/, QA[.!,]/.test(lastLine), 'the closing line uses the name the client entered (' + JSON.stringify(lastLine.slice(0, 48)) + ')');
  ok(capture && capture.missingRequired.length === 0, 'the three required fields were captured by the end');
  ok(asked.join(',') === PLAN_ORDER.join(','), 'guardrail questions were asked once each, in order');

  const more = await (await post('/api/voice/turn', { call_id: 'call-http', call_ticket: ticket, answers: fullAnswers(), asked: PLAN_ORDER, probes: {}, last_answer: 'nothing more', with_audio: false })).json();
  ok(more.ok === true, 'extra turns are accepted while under the cap');

  const speak = await (await post('/api/voice/speak', { text: 'Testing the voice.' })).json();
  ok(speak.ok && (!!speak.audio_base64 || speak.speak_with_browser === true), 'speak returns audio or the browser-voice fallback');

  const tr = await (await post('/api/voice/transcribe', { audio_base64: 'AAAA', mime: 'audio/webm' })).json();
  ok(tr.ok === true, 'transcribe answers in simulated mode without failing');
  const empty = await fetch(BASE + '/api/voice/transcribe', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ token }) });
  ok(empty.status === 400, 'transcribe refuses an empty recording');

  let bigStatus = 'refused';
  try {
    const tooLarge = await fetch(BASE + '/api/voice/transcribe', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ token, audio_base64: 'A'.repeat(9 * 1024 * 1024), mime: 'audio/webm' }) });
    bigStatus = tooLarge.status;
  } catch (e) { bigStatus = 'refused'; }
  ok(bigStatus === 413 || bigStatus === 401 || bigStatus === 'refused', 'an over-long recording is refused (' + bigStatus + ')');

  // The lead carries the call metadata through to Function D.
  const fields = fieldsFor(fullAnswers());
  const gen = await (await post('/api/generate', { fields })).json();
  const del = await (await post('/api/deliver', {
    email: 'qa@pipelinesync.ai', consent: true, fields, blueprint: gen.blueprint,
    voice_meta: {
      provider: 'simulated', mode: 'simulated', models: { chat: 'gpt-4o-mini' }, tts_voice: 'browser',
      call_id: 'call-http', started_at: new Date().toISOString(), ended_at: new Date().toISOString(),
      duration_s: 200, turns, questions_asked: asked, probes: 3, required_missing_at_call_end: [],
      transcript_turns: 24, junk: 'drop me'
    }
  })).json();
  ok(del.ok && !!del.contact_id, 'delivery still works with voice metadata attached');
}

(async () => {
  policyTests();
  captureTests();
  styleTests();
  noKeyTests();
  clampTests();
  await adapterTests();
  await httpTests();
  console.log('\n' + (failures === 0 ? 'VOICE TESTS PASSED' : failures + ' VOICE FAILURES'));
  process.exit(failures === 0 ? 0 : 1);
})().catch(e => { console.error('voice test error:', e); process.exit(1); });
