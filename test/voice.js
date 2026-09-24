/*
 * Voice layer tests: the interviewer policy, the capture state, the OpenAI adapters (stubbed),
 * and the four /api/voice routes against a dedicated server instance in simulated mode.
 *
 * Self-contained: starts its own instance on port 8091 via test/harness.js (see that file
 * for why the rate limit is relaxed and the OpenAI credentials are stripped in tests).
 */
let BASE;
const { startServer, generateBlueprint } = require('./harness');
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

  // The built-in engine has no model to notice a question, so it matches the lead's words against
  // the same scripted FAQ and answers first, leaving the assigned question for the next turn.
  ok(/free/i.test((voice.faqAnswerFor('What does this cost me?') || {}).say || ''), 'the built-in engine answers a price question from the scripted FAQ');
  ok(/AI interviewer/i.test((voice.faqAnswerFor('Am I talking to a robot?') || {}).say || ''), 'the built-in engine discloses what it is');
  ok(voice.faqAnswerFor('Twelve closed installs a month') === null, 'an ordinary answer is not mistaken for a question');
}

async function builtinInteractiveTests() {
  section('built-in engine: answer first, stop on request (no API key)');
  const turn = await voice.runTurn({
    env: {}, email: 'owner@example.com',
    body: { answers: [{ id: 'business', text: 'We install solar.' }], asked: ['business'], probes: {}, last_answer: 'What does this cost me?', call_id: 'call-sim', with_audio: false }
  });
  ok(/free/i.test(turn.say) && turn.deferred === true, 'the built-in engine answers the lead');
  ok(turn.ask.id === 'products' && turn.ask.kind === 'deferred', 'the question it did not reach stays pending, not spent');
  ok(/Simulated voice/.test(turn.say) === false, 'the FAQ answer is spoken as an answer, without the opening note');

  const next = await voice.runTurn({
    env: {}, email: 'owner@example.com',
    body: { answers: [{ id: 'business', text: 'We install solar.' }], asked: ['business'], probes: {}, last_answer: null, call_id: 'call-sim2', with_audio: false }
  });
  ok(next.ask.id === 'products' && next.done === false, 'the deferred question comes back on the next turn');

  const stopped = await voice.runTurn({
    env: {}, email: 'owner@example.com',
    body: { answers: [{ id: 'business', text: 'We install solar.' }], asked: ['business'], probes: {}, last_answer: 'Can we stop here, please?', call_id: 'call-sim3', with_audio: false }
  });
  ok(stopped.done === true && stopped.stop_requested === true && stopped.ask.id === null, 'a stop ends the built-in call too, with the figures still open');
}

async function interactiveTests() {
  section('interactive: their question first, and a stop ends the call');

  /* The server's own pair of ears. It has to be narrow: a stray "stop" inside an answer must never
     end a call, and a real request must never be missed. */
  const ends = ['Can we stop here?', 'I have to go', 'let us stop for now', 'stop the call', 'that is all for today', 'I am done for now'];
  const holds = ['hold on a second', 'can we pause', 'not right now, later today', 'give me a moment'];
  const neither = ['we stop losing deals at the survey stage', 'our own crew does the installs', 'that is all of our lead sources', 'twenty closed installs a month', 'can we stop losing leads?'];
  ok(ends.every(t => voice.stopIntent(t) === 'end'), 'an explicit stop reads as a stop (' + ends.filter(t => voice.stopIntent(t) !== 'end').join(' | ') + ')');
  ok(holds.every(t => voice.stopIntent(t) === 'hold'), 'a request to wait reads as a pause, not a stop');
  ok(neither.every(t => voice.stopIntent(t) === null), 'an answer that merely contains the word stop never ends a call');

  /* A stop ends the call even though a required figure is still missing: the capture stays, the
     question does not. */
  const partial = answersUpTo(4);              // deal size and the volumes are still open
  const asked = PLAN_ORDER.slice(0, 4);
  const stopTurn = await voice.runTurn({
    env: {}, email: 'owner@example.com',
    body: { answers: partial, asked, probes: {}, last_answer: 'I have to go, sorry', call_id: 'call-stop', with_audio: false }
  });
  ok(stopTurn.done === true && stopTurn.stop_requested === true, 'a stop from the lead ends the call');
  ok(stopTurn.ask.id === null && stopTurn.ask.kind === 'done', 'no question is left pending after a stop');
  ok(!/\?/.test(stopTurn.say), 'the closing line asks nothing (' + JSON.stringify(stopTurn.say) + ')');
  ok(/stop here|saved|pick this up/i.test(stopTurn.say), 'the closing line says the work is kept and can be resumed');

  /* A turn that is all answer: the model reports it, and the question it never asked is not spent. */
  const deferred = await voice.runTurn({
    env: { OPENAI_API_KEY: 'sk-test' }, email: 'owner@example.com', fetchImpl: () => Promise.resolve({
      ok: true, status: 200,
      text: () => Promise.resolve(JSON.stringify({
        choices: [{ message: { content: JSON.stringify({ say: 'It is free, and nothing is for sale today. Take your time.', ask_question_id: null, answered_their_question: true, deferred: true, stop_requested: false, answer_quality: 'none', captured: [] }) } }]
      }))
    }),
    body: { answers: [], asked: [], probes: {}, last_answer: 'What does this cost me?', call_id: 'call-defer', with_audio: false }
  });
  ok(deferred.deferred === true && deferred.done === false, 'an all-answer turn is reported as deferred');
  ok(deferred.ask.id === 'business' && deferred.ask.kind === 'deferred', 'the assigned question stays pending instead of being spent');
  ok(/free/i.test(deferred.say), 'the answer is what gets spoken');

  const after = await voice.runTurn({
    env: {}, email: 'owner@example.com',
    body: { answers: [], asked: [], probes: {}, last_answer: null, call_id: 'call-defer2', with_audio: false }
  });
  ok(after.ask.id === 'business' && after.ask.kind === 'opening', 'the pending question comes back on the next turn');

  /* The model asking a question back instead of answering is not a deferral: normal turns keep the
     guardrail order. */
  const normal = await voice.runTurn({
    env: {}, email: 'owner@example.com',
    body: { answers: answersUpTo(2), asked: PLAN_ORDER.slice(0, 2), probes: {}, last_answer: 'We sell solar panels.', call_id: 'call-normal', with_audio: false }
  });
  ok(normal.deferred === undefined && normal.ask.id === 'deal' && normal.done === false, 'an ordinary turn carries on in plan order');

  /* The document is the source of truth and the two code copies are meant to be the same prompts, so
     the FAQ and the guardrail set are compared rather than trusted. */
  const prompts = require('../lib/prompts');
  ok(JSON.stringify(prompts.REALTIME_FAQ) === JSON.stringify(voice.REALTIME_FAQ), 'the production FAQ copy matches the one the server runs');
  ok(JSON.stringify(prompts.INTAKE_PLAN) === JSON.stringify(voice.INTAKE_PLAN), 'the production intake plan matches the one the server runs');
  ok(/THEIR QUESTION COMES FIRST/.test(prompts.REALTIME_INSTRUCTIONS_TEMPLATE) && /WHEN THEY SAY STOP, YOU STOP/.test(prompts.REALTIME_INSTRUCTIONS_TEMPLATE),
    'the production realtime template carries the answer-first and stop rules');
  ok(/deferred: true/.test(prompts.STEP_BY_STEP_TEMPLATE) && /stop_requested: true/.test(prompts.STEP_BY_STEP_TEMPLATE),
    'the production step-by-step template carries both flags');

  const schema = voice.turnSchema().schema;
  ok(schema.required.indexOf('deferred') >= 0 && schema.required.indexOf('stop_requested') >= 0, 'the turn schema asks the model for both flags');
  ok(voice.buildMessages({ step: voice.nextStep({ answers: [], asked: [], probes: {} }), asked: [], answers: [], transcript: [], lastAnswer: null, capture: voice.captureState([], []), clientName: '' })[0].content.indexOf('stop_requested') >= 0,
    'the step-by-step prompt documents stop_requested');
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
  section('HTTP routes (dedicated instance on ' + BASE + ')');
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
  const gen = (await generateBlueprint(BASE, token, fields)).j;
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
  const srv = await startServer(8091);
  BASE = srv.base;
  process.on('exit', () => srv.stop());
  policyTests();
  captureTests();
  styleTests();
  noKeyTests();
  clampTests();
  await adapterTests();
  await interactiveTests();
  await builtinInteractiveTests();
  await httpTests();
  console.log('\n' + (failures === 0 ? 'VOICE TESTS PASSED' : failures + ' VOICE FAILURES'));
  process.exit(failures === 0 ? 0 : 1);
})().catch(e => { console.error('voice test error:', e); process.exit(1); });
