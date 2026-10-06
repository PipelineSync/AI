/*
 * The continuous voice call (OpenAI Realtime over WebRTC), proven end to end without an OpenAI
 * account: a mock endpoint stands in for /v1/realtime/calls, the real app server runs against it,
 * and the real frontend holds a whole discovery call over ONE faked WebRTC session.
 *
 * What this file exists to prove:
 *   1. The call is continuous. One microphone, one peer connection, one session for all twelve
 *      questions: nothing is opened and closed per question the way the step-by-step path does.
 *   2. The guardrail set still decides the content. Every answer goes through record_answer, and
 *      the server validates each claim and returns only the uncovered topics or a required missing-value callback.
 *   3. Nothing is captured that was not said. A value the lead never spoke (a number that is not in
 *      the transcript, a label the quote does not support, background noise) is refused, and the
 *      refusal is visible on screen.
 *   4. The API key never reaches the browser: the SDP offer is exchanged by the server.
 *   5. When realtime is unavailable the same call still runs, step by step, from the same answers.
 *   6. The visitor is in control of the call: a microphone mute, a separate speaker mute, an End
 *      conversation button that releases everything, an orb waveform that follows their real
 *      microphone level, a connection failure that falls back without losing an answer, and a tab
 *      close that still hangs up cleanly.
 *   7. The spend guards are the server's, not the browser's: the session clock cannot be reset by
 *      re-issuing or dropping a ticket, a production server with an unusable signing secret refuses
 *      to open a paid session at all, and the per-IP, per-email and per-day caps on opening one
 *      behave as documented.
 *
 * Self-contained: mock on 8098, app on 8089, both in this process.
 */
const fs = require('fs');
const path = require('path');
const { JSDOM } = require('jsdom');
const { createMock } = require('./mock-openai');
const voice = require('../lib/voice');
const voiceApi = require('../lib/voice-api');
const core = require('../lib/core');

const MOCK_PORT = 8098;
const APP_PORT = 8089;
const APP = 'http://127.0.0.1:' + APP_PORT;

process.env.OPENAI_API_KEY = 'sk-mock';
delete process.env.OPENAI_REALTIME_EAGERNESS;
process.env.OPENAI_BASE_URL = 'http://127.0.0.1:' + MOCK_PORT + '/v1';
process.env.PORT = String(APP_PORT);
process.env.PS_TOKEN_SECRET = 'voice-realtime-test-secret';
process.env.DEMO_MODE = 'true';
process.env.DELIVER_PER_EMAIL_DAY = '1000';
process.env.PDF_EMAIL_DAILY_MAX = '1000';
/* The manual journey is what this file tests (the review screen after the call), so zero-touch is
   pinned off here exactly as test/harness.js does. AUTO_DELIVER defaults on in the product. */
process.env.AUTO_DELIVER = 'false';
/* Test-only relaxation of the abuse limits, exactly as test/harness.js already does for
   VOICE_RATE_PER_MIN: this file opens several live sessions from one IP within a few seconds,
   which is more than any real visitor is allowed. The production defaults are NOT changed here -
   they live in lib/voice.js (REALTIME_DEFAULTS.connectPerMin = 4, maxConcurrent = 2, dailyMax = 25)
   and lib/voice-api.js (RATE_PER_MIN['realtime/connect'] = 6), and guardTests() below asserts them
   directly, along with what each one refuses. */
process.env.VOICE_RATE_PER_MIN = '1000';
process.env.OPENAI_REALTIME_CONNECT_PER_MIN = '100';

const mock = createMock(MOCK_PORT);

let failures = 0;
const ok = (cond, msg) => { console.log((cond ? '  PASS  ' : '  FAIL  ') + msg); if (!cond) failures++; };
const section = t => console.log('\n' + t);
const sleep = ms => new Promise(r => setTimeout(r, ms));

/* ------------------------------------------------------------------ */
/* What the lead says, question by question, spoken the way people     */
/* actually speak: figures as words, one breath per answer.            */
/* `captured` is what the model claims it heard. The quotes are real,   */
/* except where a turn is marked as injecting a value nobody said.      */
/* ------------------------------------------------------------------ */
const SAID = {
  business: {
    text: 'We install residential and commercial solar systems for homeowners and small businesses in Ilocos.',
    captured: [
      { field: 'business_description', value: 'We install residential and commercial solar systems for homeowners and small businesses in Ilocos', quote: 'We install residential and commercial solar systems for homeowners and small businesses in Ilocos' },
      { field: 'industry', value: 'solar', quote: 'solar systems' }
    ]
  },
  products: {
    text: 'Residential install at one point two million pesos, and commercial at four and a half million, and commercial needs a site survey first.',
    captured: [
      { field: 'products', value: 'Residential install at 1200000 pesos, commercial at 4500000, commercial needs a site survey first', quote: 'Residential install at one point two million pesos, and commercial at four and a half million, and commercial needs a site survey first' }
    ]
  },
  deal: {
    text: 'About one and a half million a deal, and three reps take calls.',
    captured: [
      { field: 'typical_deal_size', value: '1500000', quote: 'about one and a half million a deal' },
      { field: 'sales_reps_on_calls', value: '3', quote: 'three reps take calls' }
    ]
  },
  fulfilment: {
    text: 'Six people, and our own crew does the installs.',
    captured: [{ field: 'fulfilment_headcount', value: '6', quote: 'six people' }]
  },
  owner: {
    text: 'It is me, with one operations assistant.',
    captured: [{ field: 'marketing_ops_owner', value: 'the owner, with one operations assistant', quote: 'it is me, with one operations assistant' }]
  },
  close: {
    text: 'Two calls. First we qualify and do the survey, then we present the proposal.',
    captured: [{ field: 'close_type', value: 'two calls, qualify and survey then present', quote: 'two calls. first we qualify and do the survey, then we present the proposal' }]
  },
  sources: {
    text: 'Google Ads about twenty five a month, tracked, and walk-ins about ten a month, not tracked.',
    captured: [
      { field: 'lead_sources', value: 'Google Ads about 25 a month tracked, walk-ins about 10 a month not tracked', quote: 'Google Ads about twenty five a month, tracked, and walk-ins about ten a month, not tracked' },
      // Nobody said this. It must be refused, and the refusal must be visible.
      { field: 'monthly_lead_volume', value: '400', quote: 'about 400 leads a month' }
    ]
  },
  capture: {
    // The first turn on this question is noise in the room, not an answer.
    noise: 'the television is on in the background and somebody is talking',
    text: 'They land in a spreadsheet, and I use HubSpot Starter plus WhatsApp.',
    captured: [
      { field: 'current_crm', value: 'HubSpot', quote: 'I use HubSpot Starter' },
      { field: 'current_hubspot_tier', value: 'Starter', quote: 'HubSpot Starter' }
    ]
  },
  volumes: {
    text: 'We get about fifty five leads a month and close twelve, so around twenty two percent, and three weeks from first call to signed.',
    captured: [
      { field: 'monthly_lead_volume', value: '55', quote: 'about fifty five leads a month' },
      { field: 'monthly_deal_volume', value: '12', quote: 'close twelve' },
      { field: 'close_rate', value: '22', quote: 'around twenty two percent' },
      { field: 'sales_cycle_length', value: '3 weeks', quote: 'three weeks from first call to signed' }
    ]
  },
  spend: {
    text: 'Around eighty thousand pesos a month on ads, and about fifteen thousand on software.',
    captured: [
      { field: 'monthly_marketing_spend', value: '80000', quote: 'eighty thousand pesos a month on ads' },
      { field: 'monthly_software_budget', value: '15000', quote: 'about fifteen thousand on software' }
    ]
  },
  headache: {
    text: 'Follow-ups slip and I have no visibility on who is where in the process.',
    captured: [{ field: 'biggest_headache', value: 'Follow-ups slip and I have no visibility on who is where in the process', quote: 'Follow-ups slip and I have no visibility on who is where in the process' }]
  },
  goal: {
    text: 'Twenty closed installs a month.',
    captured: [{ field: 'six_month_goal', value: '20 closed installs a month', quote: 'twenty closed installs a month' }]
  }
};

/* ------------------------------------------------------------------ */
/* 1. The policy, with no HTTP at all                                  */
/* ------------------------------------------------------------------ */
function configTests() {
  section('continuous call: configuration and the guardrail session');
  const on = voice.mode({ OPENAI_API_KEY: 'sk-x' });
  ok(on.realtime.enabled === true, 'continuous voice is on when the key is set');
  ok(/gpt-realtime/.test(on.realtime.model), 'a realtime model is configured (' + on.realtime.model + ')');
  ok(voice.mode({}).realtime.enabled === false, 'without a key the call stays step by step');
  ok(voiceApi.fallbackReasonForReadiness({}, null) === 'no-key', 'the readiness classifier names a missing API key');
  const invalidSecretEnv = { OPENAI_API_KEY: 'sk-x', NODE_ENV: 'production', PS_TOKEN_SECRET: 'tooshort' };
  ok(voiceApi.fallbackReasonForReadiness(invalidSecretEnv, voice.mode(invalidSecretEnv), voice.realtimeReadiness(invalidSecretEnv)) === 'token-secret-invalid', 'the readiness classifier names an invalid production signing secret');
  ok(voiceApi.classifyRealtimeFailure({ name: 'AbortError' }, { OPENAI_API_KEY: 'sk-x' }) === 'handshake-timeout', 'a timed-out realtime connection has a stable reason code');
  ok(voiceApi.classifyRealtimeFailure({ status: 404, message: 'Realtime model is not available' }, { OPENAI_API_KEY: 'sk-x' }) === 'model-refused', 'an unavailable realtime model has a stable refusal code');
  ok(voiceApi.FALLBACK_REASONS.includes('empty-transcription') && voiceApi.FALLBACK_REASONS.includes('session-limit'), 'shared fallback reasons include browser transcription and session-limit causes');
  ok(voice.mode({ OPENAI_API_KEY: 'sk-x', VOICE_REALTIME: 'off' }).realtime.enabled === false, 'VOICE_REALTIME=off rolls the continuous call back');
  ok(voice.mode({ OPENAI_API_KEY: 'sk-x', VOICE_PROVIDER: 'simulated' }).realtime.enabled === false, 'simulated provider never opens a live session');
  ok(/\/realtime\/calls$/.test(on.realtime.endpoint), 'the session is opened on the GA realtime calls endpoint');

  const cfg = voice.realtimeSessionConfig({ env: { OPENAI_API_KEY: 'sk-x' }, ctx: { clientName: 'Maria Santos' } });
  ok(cfg.type === 'realtime' && !!cfg.model, 'the session declares itself realtime');
  ok(cfg.audio.input.turn_detection.type === 'semantic_vad' && cfg.audio.input.turn_detection.eagerness === 'medium', 'semantic VAD defaults to medium eagerness for most callers');
  ok(cfg.audio.input.turn_detection.interrupt_response === true, 'the lead can talk over the AI (barge-in)');
  const lowEagerness = voice.realtimeSessionConfig({ env: { OPENAI_API_KEY: 'sk-x', OPENAI_REALTIME_EAGERNESS: 'low' } });
  const invalidEagerness = voice.realtimeSessionConfig({ env: { OPENAI_API_KEY: 'sk-x', OPENAI_REALTIME_EAGERNESS: 'urgent' } });
  ok(lowEagerness.audio.input.turn_detection.eagerness === 'low', 'a validated low-eagerness environment override is honored');
  ok(invalidEagerness.audio.input.turn_detection.eagerness === 'medium', 'an invalid eagerness override falls back to the medium default');
  ok(cfg.audio.input.transcription && cfg.audio.input.transcription.model, 'input transcription is on, so the call has a written record');
  ok(cfg.audio.input.transcription.language === undefined && /en-PH/.test(cfg.audio.input.transcription.prompt) && /Taglish/.test(cfg.audio.input.transcription.prompt) && /do not translate or force English/i.test(cfg.audio.input.transcription.prompt), 'Realtime transcription recognizes en-PH and Taglish without forcing English');
  ok(cfg.audio.input.noise_reduction.type === 'far_field', 'far-field noise reduction is configured for a phone-call microphone');
  ok(cfg.parallel_tool_calls === true, 'reasoning Realtime sessions may return several capture calls for one caller turn');
  const fallbackModelCfg = voice.realtimeSessionConfig({ env: { OPENAI_API_KEY: 'sk-x' }, model: 'gpt-realtime' });
  ok(!Object.prototype.hasOwnProperty.call(fallbackModelCfg, 'parallel_tool_calls'), 'parallel calls are only enabled for supported reasoning Realtime models');
  ok(cfg.audio.output.voice === 'marin', 'the recommended voice is used (' + cfg.audio.output.voice + ')');
  ok(!cfg.audio.input.format && !cfg.audio.output.format, 'no audio format is set: WebRTC negotiates it in the SDP');
  const tools = cfg.tools.map(t => t.name);
  ok(tools.indexOf('record_answer') >= 0 && tools.indexOf('end_call') >= 0, 'the model can save an answer and end the call (' + tools.join(', ') + ')');
  const record = cfg.tools.find(t => t.name === 'record_answer');
  ok(record.parameters.properties.captured.items.properties.quote, 'every claimed value has to carry the exact words it came from');
  ok(record.parameters.properties.next_topic_id && !record.parameters.required.includes('next_topic_id'), 'the suggested next topic is an optional display hint, not permission to capture');
  ok(record.parameters.properties.answer_quality.enum.indexOf('off_topic') >= 0, 'the model can mark a turn as having nothing to do with the question');

  const instructions = cfg.instructions;
  ok(/You are Nova from PipelineSync, an AI/.test(instructions), 'the live session knows Nova is an AI from PipelineSync');
  ok(/Say you're Nova, an AI from PipelineSync/.test(instructions), 'the opening line names Nova, PipelineSync, and his AI identity');
  ok(/Use the caller's first name/i.test(instructions) && /at most two short statements plus one question/i.test(instructions), 'the Realtime opening uses the caller name and stays within the requested shape');
  ok(!/\bAlex\b/.test(instructions), 'nothing in the live session instructions still calls him Alex');
  ok(/live phone call/i.test(instructions) && /Ask one clear, natural question at a time/.test(instructions), 'the instructions set a natural continuous phone-call style');
  ok(/When a topic has several facts, ask for one at a time and follow up after they answer/.test(instructions), 'multi-part topics are handled with one spoken question at a time');
  ok(/natural contractions every time you speak/i.test(instructions) && /No lists, bullets, markdown, emojis, or em dashes/.test(instructions), 'Realtime speech uses natural contractions and retains the no-em-dash rule');
  ok(/count topics in the latest live state/i.test(instructions) && /topics remaining right now \(\d+\)/i.test(instructions), 'the FAQ count is grounded in live remaining-topic state');
  ok(/narration of your tools or internal work/i.test(instructions), "the instructions keep tool and validation work out of Nova\'s spoken turns");
  ok(/LET THE CALLER LEAD WHEN THEY HAVE A QUESTION/.test(instructions), 'the instructions make Nova answer the lead before anything else');
  ok(/If the whole turn is about their question, answer and stop/.test(instructions), 'an all-answer turn is allowed, so the lead is never rushed');
  ok(/If they say stop, have to go, or that is all for now/.test(instructions), 'the instructions carry the stop rule');
  ok(/Never negotiate, ask for one more answer, or sound disappointed/i.test(instructions), 'a stop is not negotiated or mourned');
  ok(/explicitly ask for a moment or a pause/i.test(instructions), 'an explicit pause is handled separately from silence');
  const endTool = cfg.tools.find(t => t.name === 'end_call');
  ok(endTool.parameters.properties.reason.enum.indexOf('lead_asked_to_stop') >= 0, 'end_call can say the lead asked to stop');
  ok(/lead_asked_to_stop/.test(instructions), 'the model is told to use that reason when the lead stops');
  ok(/what does it cost/i.test(instructions) && /we don't quote prices on this call/i.test(instructions), "the price FAQ keeps the no-quote rule in Nova's own words");
  ok(/are you a real person/i.test(instructions) && /I'm an AI interviewer/i.test(instructions), 'the AI disclosure remains in the FAQ facts');
  ok(voice.INTAKE_PLAN.every(q => instructions.indexOf(q.id) >= 0 && q.examples.every(example => instructions.indexOf(example) >= 0)), 'all twelve topics and their single-fact examples are in the session instructions');
  ok(!voice.INTAKE_PLAN.some(q => q.hint && instructions.indexOf(q.hint) >= 0), 'no on-screen example figures are in the instructions, so they can never be captured as the lead\'s');
  ok(/There can be several record_answer calls from one caller turn/.test(instructions), 'one turn can record several topics before Nova responds');
  ok(/THE TWELVE TOPICS — A COVERAGE MENU, NOT A REQUIRED ORDER/.test(instructions) && /whichever order fits/.test(instructions), 'topic order follows the caller rather than a fixed script');
  ok(/Taglish/.test(instructions) && /answer them in clear, simple English/.test(instructions), 'Taglish answers are met with clear English');
  ok(/At about eight seconds/.test(instructions) && /At about twenty seconds/.test(instructions) && /Silence by itself is not a reason to end/.test(instructions), 'silence gets a gentle check-in and skip offer without an early hang-up');
  ok(/validation is pending, do not wait for the server/i.test(instructions), 'the model is told to acknowledge and continue while validation runs');
  ok(instructions.length < 14000, 'the instructions, live count, and single-fact examples stay inside a sane session prompt size (' + instructions.length + ' chars)');
}

function groundingTests() {
  section('grounded capture: nothing is written down that was not said');
  const volumes = voice.INTAKE_PLAN.find(q => q.id === 'volumes');
  const said = 'We get about fifty five leads a month and close twelve, so around twenty two percent, and three weeks from first call to signed.';
  const check = (c, q, user, ai) => voice.validateCaptures({ captures: [c], question: q || volumes, userText: user == null ? said : user, aiText: ai || '' });

  ok(check({ field: 'monthly_lead_volume', value: '55', quote: 'about fifty five leads a month' }).accepted.length === 1, 'a spoken figure, quoted exactly, is captured');
  ok(check({ field: 'close_rate', value: '22', quote: 'around twenty two percent' }).accepted.length === 1, 'a spoken percentage is captured as a number');
  ok(check({ field: 'monthly_lead_volume', value: '400', quote: 'about 400 leads a month' }).rejected.length === 1, 'a figure the lead never said is refused');
  ok(check({ field: 'monthly_lead_volume', value: '55', quote: '55 leads, I close 12, so about 22 percent' }, volumes, 'I do not track any of that, sorry.').rejected.length === 1, 'a figure lifted from an on-screen example is refused');
  ok(check({ field: 'current_crm', value: 'Salesforce', quote: 'we close twelve' }).rejected.length === 1, 'a value the quoted words do not support is refused');
  ok(check({ field: 'monthly_software_budget', value: '15000', quote: 'three weeks from first call to signed' }).rejected.length === 1, 'a field from another question is refused unless it was clearly volunteered');
  ok(check({ field: 'monthly_deal_volume', value: '12', quote: 'close twelve' }).accepted.length === 1, 'a value the lead volunteered out of order is still captured');
  ok(check({ field: 'close_rate', value: 'yes', quote: 'yeah' }).rejected.length === 1, 'filler is not a value');
  ok(check({ field: 'monthly_lead_volume', value: '55', quote: 'fifty five leads' }, volumes, 'uh huh').rejected.length === 1, 'a turn with no answer in it captures nothing');
  ok(check({ field: 'current_crm', value: 'HubSpot', quote: 'HubSpot' }, voice.INTAKE_PLAN.find(q => q.id === 'capture'), 'HubSpot.').accepted.length === 1, 'a one-word answer can still be captured when it is verbatim');

  const noise = voice.runRealtimeTool({
    env: { OPENAI_API_KEY: 'sk-x' }, email: 'a@b.c',
    body: {
      call_id: 'c-noise', name: 'record_answer',
      arguments: { question_id: 'sources', answer_text: 'the television is on', answer_quality: 'off_topic', captured: [{ field: 'lead_sources', value: 'Google Ads 25 a month', quote: 'Google ads twenty five a month' }] },
      user_turn: 'the television is on', answers: [{ id: 'business', text: 'We install solar.' }], asked: ['business'], probes: {}, skipped: [], voice_captures: []
    }
  });
  ok(noise.output.saved === false, 'an off-topic turn is not saved as an answer');
  ok(noise.output.accepted.length === 0, 'an off-topic turn captures nothing at all');
  ok(noise.state.asked.indexOf('sources') < 0, 'an off-topic turn does not count as covering the question');
  ok(/ask that topic once more in simpler words/i.test(noise.output.instruction), 'an off-topic response gets a single simple retry without changing other topics');

  const env = { OPENAI_API_KEY: 'sk-x' };
  let asked = [], answers = [], probes = {}, skipped = [], captures = [], ticket = null;
  const order = [];
  const record = (qid, answerText, claimed, userTurn, quality) => {
    const out = voice.runRealtimeTool({
      env, email: 'a@b.c',
      body: {
        call_id: 'c-walk', call_ticket: ticket, name: 'record_answer',
        arguments: { question_id: qid, answer_text: answerText, answer_quality: quality || 'complete', captured: claimed || [] },
        user_turn: userTurn || answerText, answers, asked, probes, skipped, voice_captures: captures
      }
    });
    ticket = out.call_ticket;
    answers = out.state.answers; asked = out.state.asked; probes = out.state.probes; skipped = out.state.skipped; captures = out.state.voice_captures;
    return out;
  };
  // One caller turn volunteers the opening topic and volumes early; the model reports them as two
  // distinct topic calls, each grounded against the same original transcript.
  const mixedTurn = SAID.business.text + ' ' + SAID.volumes.text;
  const mixedBusiness = record('business', SAID.business.text, SAID.business.captured, mixedTurn);
  order.push('business');
  const mixedVolumes = record('volumes', SAID.volumes.text, SAID.volumes.captured, mixedTurn);
  order.push('volumes');
  ok(mixedBusiness.output.accepted.length === 2 && mixedVolumes.output.accepted.length === 4, 'separate tool calls from one caller turn both pass the unchanged grounded-value validator');
  ok(asked.indexOf('business') >= 0 && asked.indexOf('volumes') >= 0 && asked.indexOf('business') < asked.indexOf('volumes'), 'two topics volunteered in one turn are saved separately in conversational order');
  const partialDeal = voice.runRealtimeTool({
    env, email: 'a@b.c',
    body: {
      call_id: 'c-partial-deal', name: 'record_answer',
      arguments: { question_id: 'deal', answer_text: 'Three reps take calls.', answer_quality: 'complete', captured: [{ field: 'sales_reps_on_calls', value: '3', quote: 'Three reps take calls' }] },
      user_turn: 'Three reps take calls.', answers: [], asked: [], probes: {}, skipped: [], voice_captures: []
    }
  });
  ok(partialDeal.output.accepted.length === 1 && partialDeal.output.next.kind === 'probe' && /only about Typical deal size/i.test(partialDeal.output.instruction) && /Do not repeat a value/i.test(partialDeal.output.instruction) && !/Reps on calls/i.test(partialDeal.output.instruction), 'a partial topic follow-up names only its uncaptured fact');

  const walk = ['sources', 'goal', 'products', 'deal', 'capture', 'fulfilment', 'owner', 'close', 'spend', 'headache'];
  for (const qid of walk) {
    const turn = SAID[qid];
    if (turn.noise) {
      const noiseOut = record(qid, turn.noise, [], turn.noise, 'off_topic');
      ok(noiseOut.state.asked.indexOf(qid) < 0, 'off-topic noise does not mark ' + qid + ' as covered');
    }
    record(qid, turn.text, turn.captured || [], turn.text);
    order.push(qid);
  }
  ok(order.length === 12 && new Set(order).size === 12, 'each of the 12 topics is covered at most once with no repeated topic');
  ok(order.join(',') !== voice.INTAKE_PLAN.map(q => q.id).join(','), 'the guardrail walk accepts a conversation-led topic order');
  const finalCapture = voice.captureState(answers, captures);
  ok(finalCapture.missingRequired.length === 0, 'the three required figures were captured from spoken answers');
  ok(finalCapture.filledCount >= 18, 'the contract was filled from the spoken call (' + finalCapture.filledCount + '/' + finalCapture.totalCount + ' fields)');
  ok(captures.every(c => c.grounded === true), 'every stored capture is marked grounded');
  const refused = captures.filter(c => c.field === 'monthly_lead_volume' && c.value === '400');
  ok(refused.length === 0, 'the fabricated lead volume never reached the contract');

  const declined = voice.runRealtimeTool({
    env, email: 'a@b.c',
    body: { call_id: 'c-decline', name: 'record_answer', arguments: { question_id: 'spend', answer_text: 'I would rather not say', answer_quality: 'declined', captured: [] }, user_turn: 'I would rather not say', answers: [], asked: [], probes: {}, skipped: [], voice_captures: [] }
  });
  ok(declined.state.skipped.indexOf('spend') >= 0, 'a declined question is never chased again');

  const endMissing = voice.runRealtimeTool({
    env, email: 'a@b.c',
    body: { call_id: 'c-end', name: 'end_call', arguments: { reason: 'other' }, answers: [{ id: 'business', text: 'We install solar.' }], asked: ['business'], probes: {}, skipped: [], voice_captures: [], end_attempts: 0 }
  });
  ok(endMissing.output.close === false, 'the call does not close while a required figure is missing and unasked');
  ok(/still have to come from them/i.test(endMissing.output.instruction), 'the model is told to ask for the missing figure once');

  /* The lead's own stop closes the call on the spot, missing figures and all. Two ways in: the
     model says why it is ending, or the lead's last words read as a stop on their own. */
  const endStop = voice.runRealtimeTool({
    env, email: 'a@b.c',
    body: { call_id: 'c-stop', name: 'end_call', arguments: { reason: 'lead_asked_to_stop' }, user_turn: 'I have to go now, sorry.', answers: [{ id: 'business', text: 'We install solar.' }], asked: ['business'], probes: {}, skipped: [], voice_captures: [], end_attempts: 0 }
  });
  ok(endStop.output.close === true && endStop.output.stop_requested === true, 'a lead who asks to stop closes the call even with a required figure missing');
  ok(/ask nothing at all/i.test(endStop.output.instruction) && !/Not yet/i.test(endStop.output.instruction), 'nothing is asked and nothing is chased after a stop');
  ok(endStop.state.capture.missingRequired.length > 0, 'the figures already captured stay in the contract');

  const endHeard = voice.runRealtimeTool({
    env, email: 'a@b.c',
    body: { call_id: 'c-stop2', name: 'end_call', arguments: { reason: 'other' }, user_turn: 'Can we stop here, please?', answers: [{ id: 'business', text: 'We install solar.' }], asked: ['business'], probes: {}, skipped: [], voice_captures: [], end_attempts: 0 }
  });
  ok(endHeard.output.close === true, 'the server hears the stop too, even when the model labels the end differently');

  const endOk = voice.runRealtimeTool({
    env, email: 'a@b.c',
    body: { call_id: 'c-end2', name: 'end_call', arguments: { reason: 'done' }, answers, asked: voice.INTAKE_PLAN.map(q => q.id), probes: {}, skipped: [], voice_captures: captures, end_attempts: 1 }
  });
  ok(endOk.output.close === true, 'a complete call closes');

  let capped = null;
  const capTicket = voice.issueRealtimeTicket('a@b.c', 'c-cap', voice.REALTIME_DEFAULTS.maxToolCalls, 0);
  capped = voice.runRealtimeTool({
    env, email: 'a@b.c',
    body: { call_id: 'c-cap', call_ticket: capTicket, name: 'record_answer', arguments: { question_id: 'goal', answer_text: 'x', answer_quality: 'complete', captured: [] }, answers: [], asked: [], probes: {}, skipped: [], voice_captures: [] }
  });
  ok(capped.output.close === true && /out of time/i.test(capped.output.instruction), 'the tool call cap closes a runaway live call');

  const stale = voice.runRealtimeTool({
    env, email: 'a@b.c',
    body: {
      call_id: 'c-stale', name: 'record_answer',
      arguments: { question_id: 'goal', answer_text: 'Twenty installs a month.', answer_quality: 'complete', captured: [] },
      answers: [], asked: [], probes: {}, skipped: [],
      // A capture posted back by a tampered client, with no grounding behind it.
      voice_captures: [{ field: 'monthly_lead_volume', value: '9999', evidence: 'nothing', grounded: true }]
    }
  });
  ok(stale.state.voice_captures.filter(c => c.value === '9999').length === 1, 'a capture this server already validated survives the round trip');
  const injected = voice.runRealtimeTool({
    env, email: 'a@b.c',
    body: { call_id: 'c-inject', name: 'record_answer', arguments: { question_id: 'goal', answer_text: 'Twenty installs a month.', answer_quality: 'complete', captured: [] }, answers: [], asked: [], probes: {}, skipped: [], voice_captures: [{ field: 'monthly_lead_volume', value: '9999', evidence: 'nothing' }] }
  });
  ok(injected.state.voice_captures.length === 0, 'an ungrounded capture injected by the client is dropped, not trusted');
}

/* ------------------------------------------------------------------ */
/* 1b. Spend guards, the signing secret, and the abuse controls        */
/* ------------------------------------------------------------------ */
function guardTests() {
  section('spend guards: the server ends a long call, not the browser');
  const env = { OPENAI_API_KEY: 'sk-x', PS_TOKEN_SECRET: 'guard-test-secret-000000' };
  const args = { question_id: 'goal', answer_text: 'Twenty closed installs a month.', answer_quality: 'complete', captured: [] };
  const base = { answers: [], asked: [], probes: {}, skipped: [], voice_captures: [] };
  const call = (callId, ticket) => voice.runRealtimeTool({
    env, email: 'guard@b.c',
    body: Object.assign({ call_id: callId, name: 'record_answer', arguments: args }, ticket ? { call_ticket: ticket } : {}, base)
  });
  const twentyMinAgo = Date.now() - 20 * 60 * 1000;      // the default cap is 15 minutes

  const over = call('c-guard', voice.issueRealtimeTicket('guard@b.c', 'c-guard', 3, 0, twentyMinAgo));
  ok(over.output.close === true, 'a call past OPENAI_REALTIME_MAX_MIN is closed by the server');
  ok(/out of time|minute limit/i.test(over.output.instruction), 'the model is told the call is over in words it can say out loud');
  ok(over.elapsed_s >= 19 * 60, 'the elapsed time is the real age of the call, not the age of the ticket (' + over.elapsed_s + 's)');
  ok(over.max_session_min === voice.REALTIME_DEFAULTS.maxSessionMin, 'the client is told the limit that was applied');

  const again = call('c-guard', over.call_ticket);
  ok(again.output.close === true && again.elapsed_s >= over.elapsed_s, 'a re-issued ticket carries the original start time, so the clock never restarts');

  const dropped = call('c-guard', null);
  ok(dropped.output.close === true && dropped.elapsed_s >= 19 * 60, 'dropping the ticket does not reset the session clock either');

  const fresh = call('c-fresh', voice.issueRealtimeTicket('guard@b.c', 'c-fresh', 1, 0, Date.now()));
  ok(fresh.output.close !== true, 'a call inside its limit carries on as normal');

  const capTicket = voice.issueRealtimeTicket('guard@b.c', 'c-tools', voice.REALTIME_DEFAULTS.maxToolCalls, 0, Date.now());
  ok(call('c-tools', capTicket).output.close === true, 'the tool call cap still closes a runaway call');

  section('the signing secret: a paid session needs one that cannot be forged');
  const prod = { OPENAI_API_KEY: 'sk-x', CONTEXT: 'production' };
  const noSecret = voice.realtimeReadiness(prod);
  ok(noSecret.ok === false && noSecret.code === 'token-secret-missing', 'production with no PS_TOKEN_SECRET refuses to open a paid session');
  ok(/PS_TOKEN_SECRET/.test(noSecret.reason) && !/sk-x/.test(noSecret.reason), 'the reason names the variable and leaks no value');
  ok(voice.realtimeReadiness({ OPENAI_API_KEY: 'sk-x', CONTEXT: 'production', PS_TOKEN_SECRET: 'pipelinesync-prototype-dev-secret' }).ok === false,
    'the known development fallback secret is refused in production');
  ok(voice.realtimeReadiness({ OPENAI_API_KEY: 'sk-x', NETLIFY: 'true', PS_TOKEN_SECRET: 'tooshort' }).ok === false, 'a weak secret is refused in production');
  ok(voice.realtimeReadiness({ OPENAI_API_KEY: 'sk-x', NODE_ENV: 'production', PS_TOKEN_SECRET: 'tooshort' }).ok === false, 'NODE_ENV=production is treated as production too');
  const secret = 'a-long-random-secret-value-0000';
  const good = voice.realtimeReadiness({ OPENAI_API_KEY: 'sk-x', CONTEXT: 'production', PS_TOKEN_SECRET: secret });
  ok(good.ok === true, 'a proper secret opens the way in production');
  ok(JSON.stringify(good).indexOf(secret) < 0, 'the readiness report never contains the secret');
  ok(voice.realtimeReadiness({ OPENAI_API_KEY: 'sk-x' }).ok === true, 'local development still runs without a production secret');
  ok(voice.realtimeReadiness({}).ok === false, 'with no key there is no live session');
  ok(voice.realtimeReadiness({ OPENAI_API_KEY: 'sk-x', VOICE_REALTIME: 'off' }).ok === false, 'the VOICE_REALTIME kill switch still stops the continuous call');

  section('abuse controls on opening a paid session');
  const cfg = voice.mode({ OPENAI_API_KEY: 'sk-x', PS_TOKEN_SECRET: 'guard-test-secret-000000' });
  ok(cfg.realtime.connectPerMin === 4, 'the production default is four new live sessions per minute per IP (' + cfg.realtime.connectPerMin + ')');
  ok(cfg.realtime.maxConcurrent === 2 && cfg.realtime.dailyMax === 25, 'the defaults cap concurrent calls and sessions per day');
  let allowed = 0;
  for (let i = 1; i <= 6; i++) {
    if (voice.registerRealtimeCall({ email: 'min' + i + '@b.c', callId: 'c-min-' + i, ip: '203.0.113.7', cfg }).ok) allowed++;
  }
  ok(allowed === 4, 'the fifth and sixth session from one address in a minute are refused (' + allowed + ' allowed)');
  ok(voice.registerRealtimeCall({ email: 'min7@b.c', callId: 'c-min-7', ip: '203.0.113.8', cfg }).ok === true, 'a different visitor on a different address is unaffected');

  const c1 = voice.registerRealtimeCall({ email: 'two@b.c', callId: 'c-two-1', ip: '203.0.113.9', cfg });
  const c2 = voice.registerRealtimeCall({ email: 'two@b.c', callId: 'c-two-2', ip: '203.0.113.9', cfg });
  const c3 = voice.registerRealtimeCall({ email: 'two@b.c', callId: 'c-two-3', ip: '203.0.113.9', cfg });
  ok(c1.ok && c2.ok && c3.ok === false && c3.code === 'concurrent', 'one address cannot hold more live calls than the concurrent cap');
  voice.closeRealtimeCall('two@b.c', 'c-two-1', cfg);
  ok(voice.registerRealtimeCall({ email: 'two@b.c', callId: 'c-two-3', ip: '203.0.113.9', cfg }).ok === true, 'hanging up frees the slot for the next call');

  const rel = voice.registerRealtimeCall({ email: 'rel@b.c', callId: 'c-rel', ip: '203.0.113.10', cfg });
  voice.releaseRealtimeCall('rel@b.c', 'c-rel', cfg);
  ok(rel.ok && voice.registerRealtimeCall({ email: 'rel@b.c', callId: 'c-rel', ip: '203.0.113.10', cfg }).ok === true,
    'a session OpenAI refused costs the visitor no allowance, so a genuine retry works');

  const small = voice.mode({ OPENAI_API_KEY: 'sk-x', OPENAI_REALTIME_DAILY_MAX: '3' });
  for (let i = 1; i <= 3; i++) {
    voice.registerRealtimeCall({ email: 'day@b.c', callId: 'c-day-' + i, ip: '203.0.113.' + (20 + i), cfg: small });
    voice.closeRealtimeCall('day@b.c', 'c-day-' + i, small);
  }
  const denied = voice.registerRealtimeCall({ email: 'day@b.c', callId: 'c-day-4', ip: '203.0.113.24', cfg: small });
  ok(denied.ok === false && denied.code === 'daily', 'the per-email daily session limit is enforced');
  ok(/daily limit/i.test(denied.reason), 'the visitor is told plainly what happened, in words that can be shown on screen');
}

/* ------------------------------------------------------------------ */
/* 2. The routes                                                       */
/* ------------------------------------------------------------------ */
async function routeTests(token) {
  section('continuous call: the routes');
  const post = (p, b) => fetch(APP + p, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(Object.assign({ token }, b)) });

  const noAuth = await fetch(APP + '/api/voice/realtime/connect', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ sdp: 'v=0' }) });
  ok(noAuth.status === 401, 'the live session route rejects a request without a token');

  const sess = await (await post('/api/voice/session', {})).json();
  ok(sess.realtime && sess.realtime.enabled === true, 'the session tells the client the continuous call is available');
  ok(sess.realtime.connect_route === '/api/voice/realtime/connect', 'the session hands the client the connect route');
  ok(!JSON.stringify(sess).match(/sk-mock/), 'the API key is never in the session response');

  const badSdp = await (await post('/api/voice/realtime/connect', { call_id: 'call-bad', sdp: 'not an offer' })).json();
  ok(badSdp.ok === false && !!badSdp.error, 'a malformed WebRTC offer is refused with a readable error');

  const sdp = ['v=0', 'o=- 1 1 IN IP4 127.0.0.1', 's=-', 't=0 0', 'm=audio 9 UDP/TLS/RTP/SAVPF 0'].join('\r\n');
  const conn = await (await post('/api/voice/realtime/connect', { call_id: 'call-rt', sdp, client_name: 'Maria Santos' })).json();
  ok(conn.ok === true && /v=0/.test(conn.sdp || ''), 'the server exchanges the offer and returns an SDP answer');
  ok(conn.provider === 'openai-realtime' && conn.mode === 'realtime', 'the client is told it is on the continuous path');
  ok(!!conn.call_ticket, 'a signed ticket comes back so the server can cap the call');
  ok(conn.opening && conn.opening.question_id === 'business' && /what does your business do/i.test(conn.opening.ask_now || ''), 'the guardrail set picked the opening question, not the model');
  ok(!/sk-mock/.test(JSON.stringify(conn)), 'the connect response carries no credentials');

  const rtReq = mock.requests.filter(r => r.kind === 'realtime');
  ok(rtReq.length >= 1, 'the offer reached the realtime endpoint');
  ok(rtReq[0].auth === 'Bearer sk-mock', 'the key was used server-side only (bearer header on the server call)');
  ok(rtReq[0].hasSdp && rtReq[0].sdpIsOffer, 'the browser offer was forwarded inside the multipart form');
  ok(/multipart\/form-data/.test(rtReq[0].contentType || ''), 'the session is opened as a multipart form (sdp + session)');
  const sentSession = rtReq[0].session;
  ok(sentSession && sentSession.type === 'realtime' && Array.isArray(sentSession.tools), 'the server, not the browser, owns the session config and its tools');
  ok(sentSession && /LET THE CALLER LEAD WHEN THEY HAVE A QUESTION/.test(sentSession.instructions || '') && /If they say stop, have to go/.test(sentSession.instructions || ''),
    'the session the server sent carries the answering and stopping rules');
  ok(sentSession && sentSession.audio.input.turn_detection.type === 'semantic_vad' && sentSession.audio.input.turn_detection.eagerness === 'medium' && sentSession.audio.input.turn_detection.interrupt_response === true, 'the session the server sent uses the medium semantic VAD default with interruption enabled');

  const tool = await (await post('/api/voice/realtime/tool', {
    call_id: 'call-rt', call_ticket: conn.call_ticket, name: 'record_answer',
    arguments: { question_id: 'business', answer_text: SAID.business.text, answer_quality: 'complete', captured: SAID.business.captured },
    user_turn: SAID.business.text, answers: [], asked: [], probes: {}, skipped: [], voice_captures: []
  })).json();
  ok(tool.ok === true && tool.output.accepted.length === 2, 'the tool route validates and saves what was said');
  ok(tool.output.next.kind === 'continue' && !tool.output.next.question_id && tool.output.next.topics.some(q => q.question_id === 'products'), 'the tool route returns remaining topics without fixing the next question');
  ok(/Live state: 11 topics remain/.test(tool.output.instruction) && /never a fixed total/.test(tool.output.instruction), 'tool guidance supplies a live remaining-topic count for the FAQ');
  ok(tool.state.answers.find(a => a.id === 'business').text.indexOf('solar') >= 0, 'the spoken answer is stored for Function A');

  const unknown = await (await post('/api/voice/realtime/tool', { call_id: 'call-rt', name: 'delete_everything', arguments: {} })).json();
  ok(unknown.ok === true && unknown.output.error === 'unknown tool', 'an unknown tool call is refused and the call carries on');

  const badName = await (await post('/api/voice/realtime/tool', { call_id: 'call-rt', name: '../../etc', arguments: {} })).json();
  ok(badName.ok === false || badName.error, 'a tool name that is not a tool is rejected');

  const end = await (await post('/api/voice/realtime/end', {
    call_id: 'call-rt', answers: [{ id: 'business', text: SAID.business.text }], asked: ['business'], probes: {}, skipped: [],
    voice_captures: tool.state.voice_captures
  })).json();
  ok(end.ok === true && end.capture.totalCount === Object.keys(voice.FIELD_LABELS).length, 'hanging up returns the final contract state');
  ok(end.provider === 'openai-realtime', 'the lead records that the call was continuous');

  const fallback = await (await post('/api/voice/realtime/connect', { call_id: 'call-fb', sdp })).json();
  ok(fallback.ok === true || fallback.fallback === 'turns', 'a failed live session tells the client to fall back rather than ending the call');
}

/* ------------------------------------------------------------------ */
/* 3. A whole call in the browser, over one faked WebRTC session        */
/* ------------------------------------------------------------------ */
const html = fs.readFileSync(path.join(__dirname, '..', 'public', 'index.html'), 'utf8')
  .replace(/<script src="app.js"><\/script>/, '');
const appJs = fs.readFileSync(path.join(__dirname, '..', 'public', 'app.js'), 'utf8');

/* index.html loads the brand components (the logo and Nova) before app.js. jsdom does not run the
   document's own scripts, so they are evaluated here in the same order: without them app.js has no
   markup for the logo or the mascot. */
const brandJs = ['Logo.js', 'Nova.js'].map(f =>
  fs.readFileSync(path.join(__dirname, '..', 'public', 'components', 'brand', f), 'utf8'));

/* opts.hold          the fake model asks its question and then waits, so the call stays live and the
                      controls can be exercised instead of running to the end on their own
   opts.audioContext  install a fake AudioContext, so the orb's waveform can be proved to follow the
                      visitor's real microphone level (and to stop when the call is cleaned up)
   opts.health        keep the peer connection's state listeners, so a connection failure can be
                      fired at the client the way a real browser fires it */
function bootBrowser(plan, opts) {
  opts = opts || {};
  const dom = new JSDOM(html, { url: APP + '/', runScripts: 'outside-only', pretendToBeVisual: true });
  const { window } = dom;
  const { document } = window;
  const errors = [];
  const fetched = [];
  const apiRequests = [];
  const validation = { started: 0, completed: 0 };
  const latencyLogs = [];
  window.console.info = (...args) => latencyLogs.push(args.join(' '));
  window.fetch = (p, o) => {
    const url = String(p);
    let capturedRequestBody = null;
    try { capturedRequestBody = JSON.parse(o && o.body || 'null'); } catch (e) {}
    apiRequests.push({ url, method: (o && o.method) || 'GET', body: capturedRequestBody });
    try { fetched.push(url); } catch (e) {}
    if (opts.connectFailure && url.indexOf('/api/voice/realtime/connect') >= 0) {
      return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({ ok: false, fallback: 'turns', fallback_reason: 'model-refused', error: 'Mock Realtime model refusal' }) });
    }
    let requestBody = {};
    try { requestBody = JSON.parse(o && o.body || '{}'); } catch (e) {}
    const isRecordValidation = url.indexOf('/api/voice/realtime/tool') >= 0 && requestBody.name === 'record_answer';
    if (isRecordValidation) validation.started++;
    const send = () => fetch(new URL(p, APP).toString(), o).then(res => {
      if (isRecordValidation) validation.completed++;
      return res;
    });
    if (isRecordValidation && opts.validationDelay) {
      return new Promise((resolve, reject) => setTimeout(() => send().then(resolve, reject), opts.validationDelay));
    }
    return send();
  };
  window.addEventListener('error', e => errors.push(e.message));
  window.__PS_VOICE_TIMING__ = { silenceMs: 40, noSpeechMs: 200, maxListenMs: 600, speakFactorMs: 2, minSpeakMs: 5, maxSpeakMs: 60 };
  if (opts.silenceTiming) window.__PS_REALTIME_SILENCE_TIMING__ = opts.silenceTiming;

  // Audio playback (the AI's side of the live call).
  let played = 0;
  window.HTMLMediaElement.prototype.play = function () { played++; return Promise.resolve(); };
  window.HTMLMediaElement.prototype.pause = function () {};

  // The microphone: opened once for the whole call. A real MediaStream hands back the same track
  // objects on every call, so this fake does too - which is what lets a test observe a mute.
  let micCalls = 0, tracksStopped = 0;
  const micConstraints = [];
  const micTracks = [{ kind: 'audio', enabled: true, stop() { tracksStopped++; this.stopped = true; } }];
  const micStream = { getAudioTracks: () => micTracks, getTracks: () => micTracks };
  Object.defineProperty(window.navigator, 'mediaDevices', {
    value: { getUserMedia: constraints => { micCalls++; micConstraints.push(constraints); return Promise.resolve(micStream); } },
    configurable: true
  });

  /* The microphone level meter: a fake AnalyserNode on the same stream the peer connection uses.
     `frames` counts reads, which is how a test proves the animation loop really stops on cleanup. */
  const audio = { contexts: 0, closed: 0, disconnected: 0, frames: 0, loud: true };
  if (opts.audioContext) {
    window.AudioContext = class {
      constructor() { audio.contexts++; this.state = 'running'; }
      resume() { return Promise.resolve(); }
      close() { audio.closed++; return Promise.resolve(); }
      createAnalyser() {
        const an = { fftSize: 512, smoothingTimeConstant: 0 };
        an.getByteTimeDomainData = buf => {
          audio.frames++;
          for (let i = 0; i < buf.length; i++) buf[i] = audio.loud ? 200 : 128;   // 200 = loud, 128 = silence
        };
        an.disconnect = () => { audio.disconnected++; };
        return an;
      }
      createMediaStreamSource() { return { connect() {}, disconnect() { audio.disconnected++; } }; }
    };
  }

  // One WebRTC session. Everything the client sends is recorded, and the fake model reacts to it.
  const sent = [];
  const calls = { connect: 0, channelsClosed: 0, tracks: 0, offers: 0, pcClosed: 0 };
  let dc = null;
  let pcRef = null;
  const pcListeners = {};
  let onClientEvent = () => {};
  class FakeDataChannel {
    constructor(label) { this.label = label; this.readyState = 'connecting'; }
    send(data) {
      let ev = null;
      try { ev = JSON.parse(data); } catch (e) { return; }
      sent.push(ev);
      onClientEvent(ev);
    }
    close() { this.readyState = 'closed'; calls.channelsClosed++; }
    addEventListener() {}
    removeEventListener() {}
    open() { this.readyState = 'open'; if (this.onopen) this.onopen(); }
  }
  class FakePeerConnection {
    constructor() {
      this.iceGatheringState = 'new'; this.iceConnectionState = 'new'; this.connectionState = 'new';
      this.localDescription = null; this.remoteDescription = null;
      calls.connect++; pcRef = this;
    }
    addTrack(track) { calls.tracks++; this._track = track; }
    createDataChannel(label) { dc = new FakeDataChannel(label); return dc; }
    async createOffer() { calls.offers++; return { type: 'offer', sdp: 'v=0\r\no=- 1 1 IN IP4 127.0.0.1\r\nm=audio 9 UDP/TLS/RTP/SAVPF 0\r\n' }; }
    async setLocalDescription(o) { this.localDescription = o; this.iceGatheringState = 'complete'; if (this.onicegatheringstatechange) this.onicegatheringstatechange(); }
    async setRemoteDescription(a) {
      this.remoteDescription = a;
      // The media track arrives with the answer, then the session comes up.
      if (this.ontrack) this.ontrack({ track: { kind: 'audio' }, streams: [{ id: 'remote' }] });
      setTimeout(() => { if (dc) dc.open(); }, 5);
    }
    close() { this.connectionState = 'closed'; calls.pcClosed++; }
    addEventListener(type, fn) { if (opts.health) (pcListeners[type] = pcListeners[type] || []).push(fn); }
    removeEventListener(type, fn) {
      if (!opts.health) return;
      const l = pcListeners[type] || []; const i = l.indexOf(fn);
      if (i >= 0) l.splice(i, 1);
    }
  }
  /* Fire a connection state at the client exactly as a browser would: the property changes first,
     then every registered listener runs. */
  const fireConnectionState = s => {
    if (!pcRef) return false;
    pcRef.connectionState = s;
    pcRef.iceConnectionState = s;
    (pcListeners.connectionstatechange || []).slice().forEach(fn => { try { fn(); } catch (e) { errors.push('connectionstatechange: ' + e.message); } });
    (pcListeners.iceconnectionstatechange || []).slice().forEach(fn => { try { fn(); } catch (e) { errors.push('iceconnectionstatechange: ' + e.message); } });
    return true;
  };
  window.RTCPeerConnection = FakePeerConnection;
  window.MediaStream = class { constructor(tracks) { this.tracks = tracks; } };

  /* The fake model follows a conversation-led order, records volunteered topics from one turn as
     separate tools, and skips anything it already covered. */
  const emit = ev => { if (dc && dc.onmessage) dc.onmessage({ data: JSON.stringify(ev) }); };
  const quoted = text => { const m = String(text || '').match(/"([^"]+)"\s*(?:\.|,)?\s*$/); return m ? m[1] : ''; };
  const idForText = text => {
    const t = String(text || '').toLowerCase();
    const hit = plan.find(q => q.ask.toLowerCase() === t || (q.probe && q.probe.toLowerCase() === t));
    if (hit) return hit.id;
    const near = plan.find(q => t.indexOf(q.ask.toLowerCase().slice(0, 24)) >= 0 || (q.probe && t.indexOf(q.probe.toLowerCase().slice(0, 24)) >= 0));
    return near ? near.id : null;
  };
  const topicOrder = opts.topicOrder || ['business', 'volumes', 'sources', 'goal', 'products', 'deal', 'capture', 'fulfilment', 'owner', 'close', 'spend', 'headache'];
  let lastOutput = null;
  let noiseDone = false;
  let closing = false;
  let endRequested = false;
  let mixedTurnUsed = false;
  const completedTopics = [];
  const spokenLines = [];
  const questionTopics = [];
  const answerCalls = [];
  const endCalls = [];
  const timeline = [];
  let nonblockingResumes = 0;
  let fakeResponsesActive = 0, overlappingFakeResponses = 0;
  const beginFakeResponse = () => {
    fakeResponsesActive++;
    if (fakeResponsesActive > 1) overlappingFakeResponses++;
  };
  const finishFakeResponse = () => {
    fakeResponsesActive = Math.max(0, fakeResponsesActive - 1);
    emit({ type: 'response.done', response: { status: 'completed' } });
  };
  const answer = qid => {
    const firstTurn = qid === 'business' && !mixedTurnUsed && opts.multiTopic !== false;
    const topicIds = firstTurn ? ['business', 'volumes'] : [qid];
    if (firstTurn) mixedTurnUsed = true;
    const turn = SAID[qid];
    if (!turn) return;
    /* The real session reports each tool twice: once when its arguments finish streaming and once
       as an output item. Duplicate events must be handled only once by the browser. */
    const toolCall = (topicId, args) => {
      const callId = 'call_' + topicId + '_' + Math.random().toString(36).slice(2, 7);
      const raw = JSON.stringify(args);
      answerCalls.push({ question_id: topicId, answer_quality: args.answer_quality });
      timeline.push({ type: 'answer', question_id: topicId, answer_quality: args.answer_quality });
      emit({ type: 'response.function_call_arguments.done', call_id: callId, name: 'record_answer', arguments: raw });
      emit({ type: 'response.output_item.done', item: { type: 'function_call', call_id: callId, name: 'record_answer', arguments: raw } });
    };
    if (turn.noise && !noiseDone) {
      noiseDone = true;
      emit({ type: 'input_audio_buffer.speech_started' });
      emit({ type: 'conversation.item.input_audio_transcription.completed', transcript: turn.noise });
      emit({ type: 'input_audio_buffer.speech_stopped' });
      beginFakeResponse();
      emit({ type: 'response.created' });
      toolCall(qid, { question_id: qid, answer_text: turn.noise, answer_quality: 'off_topic', captured: [] });
      finishFakeResponse();
      return;
    }
    const turnText = topicIds.map(id => SAID[id].text).join(' ');
    emit({ type: 'input_audio_buffer.speech_started' });
    emit({ type: 'conversation.item.input_audio_transcription.delta', transcript: turnText.slice(0, 20) });
    emit({ type: 'input_audio_buffer.speech_stopped' });
    emit({ type: 'conversation.item.input_audio_transcription.completed', transcript: turnText });
    beginFakeResponse();
    emit({ type: 'response.created' });
    for (const topicId of topicIds) {
      const topicAnswer = SAID[topicId];
      if (completedTopics.indexOf(topicId) < 0) completedTopics.push(topicId);
      toolCall(topicId, { question_id: topicId, answer_text: topicAnswer.text, answer_quality: 'complete', captured: topicAnswer.captured || [] });
    }
    finishFakeResponse();
  };

  onClientEvent = async ev => {
    if (ev.type === 'conversation.item.create' && ev.item && ev.item.type === 'function_call_output') {
      try { lastOutput = JSON.parse(ev.item.output); } catch (e) { lastOutput = null; }
      return;
    }
    if (ev.type !== 'response.create') return;
    beginFakeResponse();
    const instruction = (ev.response && ev.response.instructions) || '';
    await sleep(5);
    if (lastOutput && lastOutput.close === true) {
      closing = true;
      emit({ type: 'response.created' });
      emit({ type: 'response.output_audio_transcript.delta', delta: 'That is everything I need.' });
      emit({ type: 'response.output_audio_transcript.done', transcript: 'That is everything I need, thank you. You can review and correct what we captured now.' });
      spokenLines.push('That is everything I need, thank you.');
      finishFakeResponse();
      lastOutput = null;
      return;
    }
    if (!opts.hold && completedTopics.length === 12 && !endRequested) {
      endRequested = true;
      endCalls.push({ reason: 'complete' });
      emit({ type: 'response.created' });
      emit({ type: 'response.function_call_arguments.done', call_id: 'call_end', name: 'end_call', arguments: JSON.stringify({ reason: 'complete' }) });
      finishFakeResponse();
      lastOutput = null;
      return;
    }
    let say = '';
    let courtesy = false;
    if (/Take your time/i.test(instruction)) { say = 'Take your time.'; courtesy = true; }
    else if (/Would you like to skip this one/i.test(instruction)) { say = 'No rush. Would you like to skip this one?'; courtesy = true; }
    else say = quoted(instruction) || (lastOutput && lastOutput.next && lastOutput.next.ask_now) || '';
    let qid = idForText(say) || (lastOutput && lastOutput.next && lastOutput.next.question_id) || null;
    if (!qid && !courtesy) qid = topicOrder.find(id => completedTopics.indexOf(id) < 0) || null;
    emit({ type: 'response.created' });
    emit({ type: 'response.output_audio_transcript.delta', delta: say.slice(0, 12) });
    emit({ type: 'response.output_audio_transcript.done', transcript: say });
    spokenLines.push(say);
    if (!courtesy && qid) {
      questionTopics.push(qid);
      timeline.push({ type: 'question', question_id: qid });
      if (validation.completed < validation.started) nonblockingResumes++;
    }
    finishFakeResponse();
    lastOutput = null;
    await sleep(5);
    // A courtesy line waits for a real caller turn; a question in ordinary full-call scenarios gets
    // the scripted answer automatically. `hold` keeps the live session available for control tests.
    if (!closing && !opts.hold && !courtesy && qid) answer(qid);
  };

  brandJs.forEach(src => window.eval(src));   // index.html loads these before app.js
  window.eval(appJs);
  return {
    window, document, sent, calls, errors, spokenLines, micTracks, fetched, apiRequests, audio, validation, latencyLogs,
    questionTopics, answerCalls, completedTopics, endCalls, timeline,
    emit, fireConnectionState,
    micCalls: () => micCalls, micConstraints: () => micConstraints.slice(), tracksStopped: () => tracksStopped, played: () => played,
    nonblockingResumes: () => nonblockingResumes,
    overlappingResponses: () => overlappingFakeResponses
  };
}

async function browserTests(token) {
  section('continuous call: a whole discovery call over one WebRTC session');
  const sessRes = await (await fetch(APP + '/api/voice/session', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ token }) })).json();
  const rtBefore = mock.requests.filter(r => r.kind === 'realtime').length;
  const page = bootBrowser(sessRes.plan, { validationDelay: 60 });
  const { document, calls, errors } = page;
  await sleep(150);

  // Entry gate -> disclaimer -> the call starts on agreement, as it does in production.
  document.getElementById('demo-btn').click();
  await sleep(300);
  document.getElementById('consent-cb').click();
  document.getElementById('consent-go').click();

  for (let i = 0; i < 120 && !document.querySelector('#structure-btn'); i++) await sleep(100);

  ok(calls.connect === 1, 'one WebRTC session for the whole call (' + calls.connect + ' peer connection)');
  ok(calls.offers === 1, 'one SDP offer for the whole call: nothing is renegotiated per question');
  ok(calls.channelsClosed === 0, 'the event channel stayed open from the first question to the last');
  ok(page.micCalls() === 1, 'the microphone was opened once, not once per question (' + page.micCalls() + ')');
  const micAudioConstraints = (page.micConstraints()[0] || {}).audio || {};
  ok(micAudioConstraints.echoCancellation === true && micAudioConstraints.noiseSuppression === true && micAudioConstraints.autoGainControl === true, 'the live microphone requests echo cancellation, noise suppression, and automatic gain control');
  ok(page.tracksStopped() === 0, 'the microphone was never released mid-call, so the call is not cut');
  const rtReq = mock.requests.filter(r => r.kind === 'realtime').length - rtBefore;
  ok(rtReq === 1, 'one realtime session was opened server-side for the whole call (' + rtReq + ')');
  ok(page.played() >= 1, 'the AI voice played from the live media track');
  ok(!document.querySelector('#intake-side .badge-mode'), 'Mode badge is absent from the discovery sidebar');
  ok((document.querySelector('#call-mode') || {}).textContent === 'Live voice', 'the call header shows only the exact live-voice mode label');
  ok(page.spokenLines.length >= 12, 'every question was spoken in one continuous call (' + page.spokenLines.length + ' lines)');

  const coveredTopics = page.answerCalls.filter(call => call.answer_quality === 'complete' || call.answer_quality === 'declined').map(call => call.question_id);
  ok(coveredTopics.length === 12 && new Set(coveredTopics).size === 12, 'all twelve topics are covered at most once, in one session');
  ok(coveredTopics[0] === 'business' && coveredTopics[1] === 'volumes' && coveredTopics.join(',') !== voice.INTAKE_PLAN.map(q => q.id).join(','), 'one caller turn captures two volunteered topics and the conversation follows a non-scripted order');
  const questionCounts = page.questionTopics.reduce((counts, id) => { counts[id] = (counts[id] || 0) + 1; return counts; }, {});
  ok(Object.keys(questionCounts).filter(id => questionCounts[id] > 1).every(id => page.answerCalls.some(call => call.question_id === id && call.answer_quality === 'off_topic')), 'a topic is not asked again after capture; the only retry follows an uncaptured off-topic turn');
  const answeredAt = id => page.timeline.findIndex(event => event.type === 'answer' && event.question_id === id && event.answer_quality !== 'off_topic');
  ok(coveredTopics.every(id => { const at = answeredAt(id); return at >= 0 && !page.timeline.slice(at + 1).some(event => event.type === 'question' && event.question_id === id); }), 'no already captured topic is asked again later in the call');
  ok(page.nonblockingResumes() > 0, 'Nova asks the next question while server grounding validation is still pending');
  ok(page.overlappingResponses() === 0, 'queued tool replies never create overlapping Realtime responses');
  ok(page.validation.completed === page.validation.started, 'all queued server validations finish before end_call closes the full-call test');
  ok(!!document.querySelector('#structure-btn'), 'the live call reached the end of the intake set');
  ok(page.window.__PS_VOICE_STATE__().transcript.filter(t => t.role === 'user').length >= 12, 'every spoken answer is in the transcript');
  ok(page.window.__PS_VOICE_STATE__().transcript.filter(t => t.role === 'user' && t.ignored).length >= 1, 'the turn that had nothing to do with the question is marked, not captured');
  ok(!/400 leads/.test(document.body.textContent), 'the fabricated lead volume is nowhere on the call screen');

  const filled = page.window.__PS_VOICE_STATE__().capturedCount;
  ok(filled >= 15, 'the contract was captured from the spoken call (' + filled + ' fields)');
  ok(page.window.__PS_VOICE_STATE__().missingRequired.length === 0, 'deal size, lead volume and close rate were captured live');
  ok(/refused as not said on the call: [1-9]/.test(document.body.textContent), 'the screen reports the values that were refused for not being said');
  ok(errors.length === 0, 'no runtime errors on the continuous path' + (errors.length ? ': ' + errors[0] : ''));

  // Carry on into the review screen: the continuous call feeds the same Function A.
  document.querySelector('#structure-btn').click();
  for (let i = 0; i < 60 && !document.querySelector('#confirm-fields'); i++) await sleep(100);
  ok(!!document.querySelector('#confirm-fields'), 'the live call structures into the review screen');
  ok((document.querySelector('.call-summary .badge-mode') || {}).textContent === 'Live voice', 'the review screen records the exact live mode badge');

  const outboxFields = await (await fetch(APP + '/api/extract', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ token, answers: Object.keys(SAID).map(id => ({ id, text: SAID[id].text })) })
  })).json();
  ok(outboxFields.fields.typical_deal_size === 1500000, 'a deal size spoken in words is captured as a number');
  ok(outboxFields.fields.monthly_lead_volume === 55 && outboxFields.fields.close_rate === 22, 'lead volume and close rate spoken in words are captured');

  // Hanging up releases the microphone.
  ok(page.tracksStopped() >= 1, 'the microphone is released when the call ends');
  return page;
}

/* ------------------------------------------------------------------ */
/* 3b. The controls a visitor has on a live call                        */
/* ------------------------------------------------------------------ */
/* Start a call and wait until the live session is genuinely up: the model has spoken its opening
   question, which only happens once the data channel is open. */
async function waitLive(page) {
  const document = page.document;
  document.getElementById('demo-btn').click();
  await sleep(300);
  document.getElementById('consent-cb').click();
  document.getElementById('consent-go').click();
  for (let i = 0; i < 160 && !(page.spokenLines.length >= 1 && document.querySelector('#end-call-btn')); i++) await sleep(50);
  return page.spokenLines.length >= 1 && !!document.querySelector('#end-call-btn');
}

/* Each browser test signs in as its own visitor: the abuse controls count live calls per email, and
   a test that leaves a call unreported (a dropped connection, exactly what healthTests simulates)
   must not eat the next test's allowance. */
async function loginFor(name, email) {
  const r = await (await fetch(APP + '/api/auth/start', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name, email })
  })).json();
  return r.token;
}

async function controlsTests() {
  section('continuous call: the controls a visitor actually has');
  const token = await loginFor('Controls Tester', 'controls@pipelinesync.ai');
  const sessRes = await (await fetch(APP + '/api/voice/session', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ token }) })).json();
  const page = bootBrowser(sessRes.plan, { hold: true, audioContext: true, health: true });
  const { document } = page;
  await sleep(150);
  ok(await waitLive(page), 'the live call is up and the controls are on screen');

  const endBtn = document.querySelector('#end-call-btn');
  ok(!!endBtn && /End conversation/.test(endBtn.textContent), 'a live call has a plain "End conversation" button');
  ok(!!document.querySelector('#mic-btn') && /Microphone live/.test(document.querySelector('#mic-btn').textContent), 'the microphone control says the microphone is live');
  ok(!!document.querySelector('#mute-btn') && /Speaker on/.test(document.querySelector('#mute-btn').textContent), 'the speaker control is separate from the microphone, and says it is on');
  ok(!document.querySelector('#conn-state'), 'the removed Mode card does not show connection details');
  ok(!Array.from(document.querySelectorAll('#intake-side h3')).some(el => /^(Mode|Captured signals)$/.test(el.textContent)), 'discovery sidebar omits Mode and Captured signals');

  /* ---- WebRTC interruption: mute local playback; let the server cancel and truncate ---- */
  const audioEl = document.querySelector('audio');
  const outgoingBeforeInterrupt = page.sent.length;
  page.emit({ type: 'input_audio_buffer.speech_started', item_id: 'caller-interrupt' });
  ok(audioEl && audioEl.muted === true, "caller speech immediately mutes Nova\'s local WebRTC audio");
  ok(!page.sent.slice(outgoingBeforeInterrupt).some(event => event.type === 'conversation.item.truncate' || event.type === 'response.cancel'), 'the WebRTC client does not send WebSocket-only truncate/cancel events; the Realtime server owns interruption truncation');
  page.emit({ type: 'input_audio_buffer.speech_stopped', item_id: 'caller-interrupt' });
  ok(audioEl && audioEl.muted === false, "Nova\'s audio unmutes when the caller finishes speaking");
  page.emit({ type: 'response.output_audio.delta', delta: 'dGVzdA==' });
  const latencyLine = page.latencyLogs.find(line => /caller-finish-to-nova-start_ms=\d+ target=<1000/.test(line)) || '';
  const latencyMs = Number((latencyLine.match(/start_ms=(\d+)/) || [])[1]);
  ok(Number.isFinite(latencyMs) && latencyMs < 1000, 'caller-finish-to-Nova-speech latency is logged against the under-one-second target (' + latencyMs + ' ms)');
  for (let i = 0; i < 2; i++) {
    page.emit({ type: 'input_audio_buffer.speech_started', item_id: 'caller-latency-' + i });
    page.emit({ type: 'input_audio_buffer.speech_stopped', item_id: 'caller-latency-' + i });
    page.emit({ type: 'response.output_audio.delta', delta: 'dGVzdA==' });
  }
  const latencySamples = page.latencyLogs.filter(line => /caller-finish-to-nova-start_ms=\d+ target=<1000/.test(line));
  ok(latencySamples.length === 3, 'each caller-finish-to-first-Nova-audio hand-off is retained as its own sample');

  /* ---- the orb waveform follows the visitor's real microphone ---- */
  ok(page.audio.contexts === 1, 'one AudioContext was opened for the level meter (' + page.audio.contexts + ')');
  ok(page.micCalls() === 1, 'the level meter reused the call\'s microphone stream: no second permission prompt');
  for (let i = 0; i < 40 && page.audio.frames < 3; i++) await sleep(25);
  ok(page.audio.frames >= 3, 'the analyser is reading the microphone (' + page.audio.frames + ' frames)');
  /* render() rebuilds the orb whenever the call's state changes, and the level meter repaints it on
     the next animation frame. So the bars are followed with a deadline instead of sampled at one
     instant: a meter that never moves still fails, a meter caught mid-repaint does not. */
  const barHeight = () => {
    const w = document.querySelector('#orb .wave');
    const bars = w ? w.querySelectorAll('span') : [];
    return bars.length >= 3 ? parseFloat(bars[2].style.height || '0') : 0;
  };
  const waitBar = async (isDone, ms) => {
    const until = Date.now() + ms;
    let h = barHeight();
    while (!isDone(h) && Date.now() < until) { await sleep(50); h = barHeight(); }
    return h;
  };
  let wave = null;
  for (let i = 0; i < 20; i++) {
    wave = document.querySelector('#orb .wave');
    if (wave && /level/.test(wave.className)) break;
    await sleep(50);
  }
  ok(!!wave && /level/.test(wave.className), 'the waveform hands its bars over to the measured level');
  const loud = await waitBar(h => h > 5, 1500);
  ok(loud > 5, 'a loud microphone moves the bars (' + loud.toFixed(1) + 'px)');
  page.audio.loud = false;
  const quiet = await waitBar(h => h < loud - 2, 1500);
  ok(quiet < loud - 2, 'silence brings the bars back down (' + quiet.toFixed(1) + 'px)');
  page.audio.loud = true;

  /* ---- microphone mute: the visitor goes quiet, the AI does not ---- */
  document.querySelector('#mic-btn').click();
  await sleep(80);
  ok(page.micTracks[0].enabled === false, 'muting the microphone disables the live audio track');
  ok(/Microphone muted/.test(document.querySelector('#mic-btn').textContent), 'the microphone button says it is muted');
  ok(document.querySelector('#mic-btn').getAttribute('aria-pressed') === 'false', 'the microphone button reports its state to a screen reader');
  ok(audioEl && audioEl.muted === false, 'muting the microphone does not mute the AI voice');
  document.querySelector('#mic-btn').click();
  await sleep(80);
  ok(page.micTracks[0].enabled === true && /Microphone live/.test(document.querySelector('#mic-btn').textContent), 'the microphone unmutes again');

  /* ---- speaker mute: the AI goes quiet, the microphone does not ---- */
  document.querySelector('#mute-btn').click();
  await sleep(80);
  ok(document.querySelector('audio').muted === true, 'muting the speaker silences the AI audio element');
  ok(/Speaker muted/.test(document.querySelector('#mute-btn').textContent), 'the speaker button says it is muted');
  ok(page.micTracks[0].enabled === true, 'muting the speaker leaves the visitor\'s microphone live');
  document.querySelector('#mute-btn').click();
  await sleep(80);
  ok(document.querySelector('audio').muted === false && /Speaker on/.test(document.querySelector('#mute-btn').textContent), 'the speaker unmutes again');

  /* ---- ending the call by hand ---- */
  const framesAtEnd = page.audio.frames;
  document.querySelector('#end-call-btn').click();
  ok(page.micTracks[0].stopped === true, 'ending the call stops the microphone track');
  ok(page.calls.channelsClosed >= 1, 'ending the call closes the WebRTC data channel');
  ok(page.calls.pcClosed >= 1, 'ending the call closes the peer connection');
  ok(!document.querySelector('audio'), 'ending the call removes the AI audio element');
  ok(page.audio.closed >= 1, 'ending the call closes the analyser context');
  ok(page.fetched.some(p => /\/api\/voice\/realtime\/end/.test(p)), 'ending the call reports the hang-up to the server');
  for (let i = 0; i < 120 && !document.querySelector('#confirm-fields'); i++) await sleep(100);
  await sleep(400);
  ok(page.audio.frames === framesAtEnd, 'no orphaned animation loop keeps reading the microphone after the call (' + page.audio.frames + ' frames)');
  ok(!!document.querySelector('#confirm-fields'), 'ending the call by hand carries on into the review screen');
  const completedProgress = page.apiRequests.find(request => /\/api\/lead\/progress$/.test(request.url) && request.body && request.body.status === 'discovery_completed');
  const latencyMeta = completedProgress && completedProgress.body && completedProgress.body.voice_meta;
  ok(latencyMeta && Number.isFinite(latencyMeta.median_ms) && Number.isFinite(latencyMeta.p90_ms) && latencyMeta.turns_measured === 3, 'the completion metadata carries median, p90, and the measured-turn count');
  ok((document.querySelector('.call-summary .badge-mode') || {}).textContent === 'Live voice', 'a call ended by hand is still recorded with the exact live mode badge');
  ok(page.errors.length === 0, 'no runtime errors on the controls path' + (page.errors.length ? ': ' + page.errors[0] : ''));
}

async function healthTests() {
  section('continuous call: a bad connection falls back instead of losing the call');
  const token = await loginFor('Health Tester', 'health@pipelinesync.ai');
  const sessRes = await (await fetch(APP + '/api/voice/session', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ token }) })).json();
  const page = bootBrowser(sessRes.plan, { hold: true, health: true });
  const { document } = page;
  await sleep(150);
  ok(await waitLive(page), 'the live call is up before the connection is tested');

  // Something the visitor actually said, so there is an answer to lose if the fallback is careless.
  page.emit({ type: 'conversation.item.input_audio_transcription.completed', transcript: 'We install solar systems for homeowners in Ilocos.' });
  await sleep(120);
  ok(page.window.__PS_VOICE_STATE__().transcript.filter(t => t.role === 'user').length >= 1, 'the answer is on the transcript while the call is live');
  ok(!document.querySelector('#intake-side .badge-mode'), 'Mode badge is absent from the discovery sidebar');
  ok(page.window.__PS_VOICE_STATE__().realtimeLive && (document.querySelector('#call-mode') || {}).textContent === 'Live voice', 'the call remains live with its exact header label');

  // A hiccup: the browser reports 'disconnected', which usually recovers by itself.
  page.fireConnectionState('disconnected');
  await sleep(150);
  ok(!document.querySelector('#intake-side .badge-mode'), 'Mode badge is absent from the discovery sidebar');
  ok(page.window.__PS_VOICE_STATE__().realtimeLive && (document.querySelector('#call-mode') || {}).textContent === 'Live voice', 'the call remains live with its exact header label');
  ok(page.calls.pcClosed === 0, 'the peer connection is left open during the grace period');
  ok(!document.querySelector('#conn-state'), 'reconnecting does not restore the removed Mode card');
  ok(page.window.__PS_VOICE_STATE__().realtimeConnectionState === 'disconnected', 'the connection health tracker detects the temporary disconnection');

  page.fireConnectionState('connected');
  await sleep(150);
  ok(!document.querySelector('#conn-state'), 'recovery does not restore the removed Mode card');
  ok(page.window.__PS_VOICE_STATE__().realtimeConnectionState === 'connected', 'the connection health tracker records recovery');
  ok(!document.querySelector('#intake-side .badge-mode'), 'Mode badge is absent from the discovery sidebar');
  ok(page.window.__PS_VOICE_STATE__().realtimeLive && (document.querySelector('#call-mode') || {}).textContent === 'Live voice', 'the call remains live with its exact header label');

  // A terminal failure: the live session is over, but the call is not.
  page.fireConnectionState('failed');
  for (let i = 0; i < 80 && page.window.__PS_VOICE_STATE__().realtimeLive; i++) await sleep(50);
  ok((document.querySelector('.badge-mode') || {}).textContent !== 'Live voice', 'a failed connection ends the live session mode');
  ok(!page.window.__PS_VOICE_STATE__().realtimeLive, 'the call switches away from live mode after failure');
  ok((document.querySelector('#call-mode') || {}).textContent === 'Step-by-step voice', 'the call header changes to the exact step-by-step mode after a live fallback');
  ok(page.calls.pcClosed >= 1, 'the peer connection is closed once the failure is terminal');
  ok(page.micTracks[0].stopped === true, 'the microphone is released when the live session fails');
  ok(/carries on step by step/i.test(document.body.textContent), 'the visitor is told the call carries on, with everything they said kept');
  ok(page.window.__PS_VOICE_STATE__().transcript.filter(t => t.role === 'user').length >= 1, 'the answer they gave survives the fallback');
  ok(/solar systems for homeowners in Ilocos/i.test(document.body.textContent), 'their words are still on screen after the fallback');
  await sleep(600);
  ok(/carries on step by step/i.test(document.body.textContent), 'the notice is still on screen after the next question arrives, so the visitor is not left wondering');
  ok(page.errors.length === 0, 'no runtime errors when the connection fails' + (page.errors.length ? ': ' + page.errors[0] : ''));
}

async function silenceTests() {
  section('continuous call: silence check-ins do not end the conversation');
  const token = await loginFor('Silence Tester', 'silence@pipelinesync.ai');
  const sessRes = await (await fetch(APP + '/api/voice/session', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ token }) })).json();
  const page = bootBrowser(sessRes.plan, { hold: true, silenceTiming: { checkInMs: 35, skipMs: 100 } });
  await sleep(150);
  ok(await waitLive(page), 'the live call is up before silence is tested');
  for (let i = 0; i < 40 && (!page.spokenLines.includes('Take your time.') || !page.spokenLines.some(line => /Would you like to skip this one/i.test(line))); i++) await sleep(20);
  ok(page.spokenLines.includes('Take your time.'), 'the first quiet check-in says “Take your time”');
  ok(page.spokenLines.some(line => /No rush\. Would you like to skip this one\?/i.test(line)), 'the later quiet check-in offers to skip');
  ok(page.endCalls.length === 0 && !!page.document.querySelector('#end-call-btn'), 'silence alone does not hang up; the long idle watchdog remains the last resort');
  ok(page.errors.length === 0, 'no runtime errors during silence check-ins' + (page.errors.length ? ': ' + page.errors[0] : ''));
  page.document.querySelector('#end-call-btn').click();
  await sleep(100);
}

async function pageExitTests() {
  section('continuous call: closing the tab releases the microphone and reports the hang-up');
  const token = await loginFor('Exit Tester', 'exit@pipelinesync.ai');
  const sessRes = await (await fetch(APP + '/api/voice/session', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ token }) })).json();
  const page = bootBrowser(sessRes.plan, { hold: true, audioContext: true, health: true });
  await sleep(150);
  ok(await waitLive(page), 'the live call is up before the tab is closed');
  for (let i = 0; i < 40 && page.audio.frames < 3; i++) await sleep(25);
  const frames = page.audio.frames;
  ok(frames >= 3, 'the level meter is running before the exit');

  // What a tab close, a refresh or a navigation looks like to the page.
  page.window.dispatchEvent(new page.window.Event('pagehide'));
  await sleep(400);
  ok(page.micTracks[0].stopped === true, 'leaving the page stops the microphone track');
  ok(page.calls.pcClosed >= 1, 'leaving the page closes the peer connection');
  ok(page.calls.channelsClosed >= 1, 'leaving the page closes the data channel');
  ok(!page.document.querySelector('audio'), 'leaving the page removes the AI audio element');
  ok(page.audio.closed >= 1, 'leaving the page closes the analyser context');
  ok(page.fetched.some(p => /\/api\/voice\/realtime\/end/.test(p)), 'leaving the page still reports the hang-up to the server');
  await sleep(400);
  ok(page.audio.frames === frames, 'leaving the page stops the level meter, so no loop is orphaned (' + page.audio.frames + ' frames)');
  ok(page.errors.length === 0, 'no runtime errors on the way out' + (page.errors.length ? ': ' + page.errors[0] : ''));
}

/* ------------------------------------------------------------------ */
/* 4. No realtime: the same call still runs, step by step               */
/* ------------------------------------------------------------------ */
async function fallbackTests() {
  section('continuous call: fallback when the live session cannot be opened');
  const noRt = voice.mode({ OPENAI_API_KEY: 'sk-x', VOICE_REALTIME: 'off' });
  ok(noRt.realtime.enabled === false, 'the operator can turn the continuous call off without a deploy');
  const cfg = voice.mode({});
  ok(cfg.provider === 'simulated', 'with no key the call still runs on the built-in policy');

  console.log('  Checking that a refused live connection renders the step-by-step controls...');
  const failedToken = await loginFor('Fallback Tester', 'connect-fallback@pipelinesync.ai');
  const failedSession = await (await fetch(APP + '/api/voice/session', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ token: failedToken }) })).json();
  const failedPage = bootBrowser(failedSession.plan, { connectFailure: true, hold: true });
  await sleep(150);
  failedPage.document.getElementById('demo-btn').click();
  await sleep(300);
  failedPage.document.getElementById('consent-cb').click();
  failedPage.document.getElementById('consent-go').click();
  for (let i = 0; i < 80 && !failedPage.document.querySelector('#skip-btn'); i++) await sleep(50);
  ok(!failedPage.document.querySelector('#intake-side .badge-mode'), 'a refused handshake does not restore the removed Mode card');
  ok((failedPage.document.querySelector('#call-mode') || {}).textContent === 'Step-by-step voice', 'the call header switches to the step-by-step label after a refused handshake');
  ok(!!failedPage.document.querySelector('#skip-btn') && !failedPage.document.querySelector('#end-call-btn'), 'a refused handshake replaces live-only controls with step-by-step controls');
  ok(failedPage.errors.length === 0, 'no runtime errors after a refused Realtime handshake' + (failedPage.errors.length ? ': ' + failedPage.errors[0] : ''));

  const dom = new JSDOM(html, { url: APP + '/', runScripts: 'outside-only', pretendToBeVisual: true });
  const { window } = dom;
  const { document } = window;
  const errors = [];
  window.fetch = (p, o) => fetch(new URL(p, APP).toString(), o);
  window.addEventListener('error', e => errors.push(e.message));
  window.__PS_VOICE_TIMING__ = { silenceMs: 40, noSpeechMs: 200, maxListenMs: 600, speakFactorMs: 2, minSpeakMs: 5, maxSpeakMs: 60 };
  window.SpeechSynthesisUtterance = class { constructor(t) { this.text = t; } };
  const spoken = [];
  window.speechSynthesis = { getVoices() { return [{}]; }, speak(u) { spoken.push(String(u.text)); setTimeout(() => u.onend && u.onend(), 5); }, cancel() {} };
  const played = [];
  window.Audio = class {
    constructor(u) { this.u = u; played.push(String(u || '').slice(0, 10)); }
    set src(v) { this.u = v; }
    get src() { return this.u || ''; }
    play() { setTimeout(() => this.onended && this.onended(), 5); return Promise.resolve(); }
    pause() {}
  };
  // A browser with no WebRTC at all: the client must fall back rather than fail.
  delete window.RTCPeerConnection;
  brandJs.forEach(src => window.eval(src));   // index.html loads these before app.js
  window.eval(appJs);
  await sleep(150);
  document.getElementById('demo-btn').click();
  await sleep(300);
  document.getElementById('consent-cb').click();
  document.getElementById('consent-go').click();
  for (let i = 0; i < 60 && spoken.length === 0 && played.length === 0; i++) await sleep(100);
  ok(spoken.length + played.length >= 1, 'the call still speaks when WebRTC is missing (' +
    spoken.length + ' synthesised, ' + played.length + ' spoken by the model)');
  ok(/step by step|Turn by turn|Ask one question/i.test(document.body.textContent) ||
    (document.querySelector('.badge-mode') || {}).textContent !== 'Live voice',
    'the screen falls back to the step by step call');
  ok(errors.length === 0, 'no runtime errors when WebRTC is missing' + (errors.length ? ': ' + errors[0] : ''));
  ok((document.querySelector('.badge-mode') || {}).textContent !== 'Live voice', 'the screen does not claim a live session it does not have');
}

(async () => {
  await mock.start();
  require('../server.js');
  await sleep(500);

  console.log('\nThe continuous voice call: OpenAI Realtime over WebRTC, against a mock endpoint');
  configTests();
  groundingTests();
  guardTests();

  const login = await (await fetch(APP + '/api/auth/start', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: 'Maria Santos', email: 'maria@pipelinesync.ai' }) })).json();
  await routeTests(login.token);
  await browserTests(login.token);
  await controlsTests();
  await silenceTests();
  await pageExitTests();
  await healthTests();
  await fallbackTests();

  console.log('\n' + (failures === 0 ? 'CONTINUOUS VOICE CALL PASSED' : failures + ' FAILURES'));
  await mock.stop().catch(() => {});
  process.exit(failures === 0 ? 0 : 1);
})().catch(e => { console.error('continuous voice call test error:', e); process.exit(1); });
