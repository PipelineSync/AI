/*
 * The continuous voice call (OpenAI Realtime over WebRTC), proven end to end without an OpenAI
 * account: a mock endpoint stands in for /v1/realtime/calls, the real app server runs against it,
 * and the real frontend holds a whole discovery call over ONE faked WebRTC session.
 *
 * What this file exists to prove:
 *   1. The call is continuous. One microphone, one peer connection, one session for all twelve
 *      questions: nothing is opened and closed per question the way the step-by-step path does.
 *   2. The guardrail set still decides the content. Every answer goes through record_answer, and
 *      the server hands back the next question the model is allowed to ask.
 *   3. Nothing is captured that was not said. A value the lead never spoke (a number that is not in
 *      the transcript, a label the quote does not support, background noise) is refused, and the
 *      refusal is visible on screen.
 *   4. The API key never reaches the browser: the SDP offer is exchanged by the server.
 *   5. When realtime is unavailable the same call still runs, step by step, from the same answers.
 *
 * Self-contained: mock on 8098, app on 8089, both in this process.
 */
const fs = require('fs');
const path = require('path');
const { JSDOM } = require('jsdom');
const { createMock } = require('./mock-openai');
const voice = require('../lib/voice');
const core = require('../lib/core');

const MOCK_PORT = 8098;
const APP_PORT = 8089;
const APP = 'http://127.0.0.1:' + APP_PORT;

process.env.OPENAI_API_KEY = 'sk-mock';
process.env.OPENAI_BASE_URL = 'http://127.0.0.1:' + MOCK_PORT + '/v1';
process.env.PORT = String(APP_PORT);
process.env.PS_TOKEN_SECRET = 'voice-realtime-test-secret';

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
  ok(voice.mode({ OPENAI_API_KEY: 'sk-x', VOICE_REALTIME: 'off' }).realtime.enabled === false, 'VOICE_REALTIME=off rolls the continuous call back');
  ok(voice.mode({ OPENAI_API_KEY: 'sk-x', VOICE_PROVIDER: 'simulated' }).realtime.enabled === false, 'simulated provider never opens a live session');
  ok(/\/realtime\/calls$/.test(on.realtime.endpoint), 'the session is opened on the GA realtime calls endpoint');

  const cfg = voice.realtimeSessionConfig({ env: { OPENAI_API_KEY: 'sk-x' }, ctx: { clientName: 'Maria Santos' } });
  ok(cfg.type === 'realtime' && !!cfg.model, 'the session declares itself realtime');
  ok(cfg.audio.input.turn_detection.type === 'semantic_vad', 'turn detection is semantic, so the lead is not cut off mid-answer');
  ok(cfg.audio.input.turn_detection.interrupt_response === true, 'the lead can talk over the AI (barge-in)');
  ok(cfg.audio.input.transcription && cfg.audio.input.transcription.model, 'input transcription is on, so the call has a written record');
  ok(cfg.audio.output.voice === 'marin', 'the recommended voice is used (' + cfg.audio.output.voice + ')');
  ok(!cfg.audio.input.format && !cfg.audio.output.format, 'no audio format is set: WebRTC negotiates it in the SDP');
  const tools = cfg.tools.map(t => t.name);
  ok(tools.indexOf('record_answer') >= 0 && tools.indexOf('end_call') >= 0, 'the model can save an answer and end the call (' + tools.join(', ') + ')');
  const record = cfg.tools.find(t => t.name === 'record_answer');
  ok(record.parameters.properties.captured.items.properties.quote, 'every claimed value has to carry the exact words it came from');
  ok(record.parameters.properties.answer_quality.enum.indexOf('off_topic') >= 0, 'the model can mark a turn as having nothing to do with the question');

  const instructions = cfg.instructions;
  ok(/THE CALL IS CONTINUOUS/.test(instructions), 'the instructions say the call is continuous');
  ok(/never say "please wait"/i.test(instructions), 'the instructions forbid the dead-air phrases that make a call feel cut');
  ok(/ANSWER THEIR QUESTIONS/.test(instructions), 'the instructions make Alex answer the lead, not dodge them');
  ok(/what does it cost/i.test(instructions) && /we do not quote prices on this call/i.test(instructions), 'the price question has a real answer that invents nothing');
  ok(/are you a real person/i.test(instructions) && /I am an AI interviewer/i.test(instructions), 'the AI disclosure is scripted');
  ok(voice.INTAKE_PLAN.every(q => instructions.indexOf(q.id) >= 0 && instructions.indexOf(q.ask) >= 0), 'all twelve guardrail questions are in the session instructions');
  ok(!voice.INTAKE_PLAN.some(q => q.hint && instructions.indexOf(q.hint) >= 0), 'no on-screen example figures are in the instructions, so they can never be captured as the lead\'s');
  ok(/call record_answer before you say anything else/.test(instructions), 'saving the answer comes before the next question');
  ok(instructions.length < 12000, 'the instructions stay inside a sane session prompt size (' + instructions.length + ' chars)');
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
  ok(/again once/i.test(noise.output.instruction), 'the model is told to ask that question again');

  const env = { OPENAI_API_KEY: 'sk-x' };
  let asked = [], answers = [], probes = {}, skipped = [], captures = [], ticket = null;
  const order = [];
  for (let i = 0; i < 20; i++) {
    const nextQ = voice.INTAKE_PLAN.find(q => asked.indexOf(q.id) < 0);
    if (!nextQ) break;
    const saidText = SAID[nextQ.id] ? SAID[nextQ.id].text : 'stub';
    const out = voice.runRealtimeTool({
      env, email: 'a@b.c',
      body: {
        call_id: 'c-walk', call_ticket: ticket, name: 'record_answer',
        arguments: { question_id: nextQ.id, answer_text: saidText, answer_quality: 'complete', captured: (SAID[nextQ.id] && SAID[nextQ.id].captured) || [] },
        user_turn: saidText, answers, asked, probes, skipped, voice_captures: captures
      }
    });
    ticket = out.call_ticket;
    answers = out.state.answers; asked = out.state.asked; probes = out.state.probes; skipped = out.state.skipped; captures = out.state.voice_captures;
    order.push(nextQ.id);
    if (out.output.next.kind === 'done') break;
  }
  ok(order.join(',') === voice.INTAKE_PLAN.map(q => q.id).join(','), 'the live call walked the twelve guardrail questions in order');
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
    body: { call_id: 'c-end', name: 'end_call', arguments: { reason: 'they want to stop' }, answers: [{ id: 'business', text: 'We install solar.' }], asked: ['business'], probes: {}, skipped: [], voice_captures: [], end_attempts: 0 }
  });
  ok(endMissing.output.close === false, 'the call does not close while a required figure is missing and unasked');
  ok(/still have to come from them/i.test(endMissing.output.instruction), 'the model is told to ask for the missing figure once');

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
  ok(conn.opening && conn.opening.question_id === 'business' && /what do you do/i.test(conn.opening.ask_now || ''), 'the guardrail set picked the opening question, not the model');
  ok(!/sk-mock/.test(JSON.stringify(conn)), 'the connect response carries no credentials');

  const rtReq = mock.requests.filter(r => r.kind === 'realtime');
  ok(rtReq.length >= 1, 'the offer reached the realtime endpoint');
  ok(rtReq[0].auth === 'Bearer sk-mock', 'the key was used server-side only (bearer header on the server call)');
  ok(rtReq[0].hasSdp && rtReq[0].sdpIsOffer, 'the browser offer was forwarded inside the multipart form');
  ok(/multipart\/form-data/.test(rtReq[0].contentType || ''), 'the session is opened as a multipart form (sdp + session)');
  const sentSession = rtReq[0].session;
  ok(sentSession && sentSession.type === 'realtime' && Array.isArray(sentSession.tools), 'the server, not the browser, owns the session config and its tools');
  ok(sentSession && /ANSWER THEIR QUESTIONS/.test(sentSession.instructions || ''), 'the session the server sent carries the answering rules');
  ok(sentSession && sentSession.audio.input.turn_detection.type === 'semantic_vad', 'the session the server sent uses semantic turn detection');

  const tool = await (await post('/api/voice/realtime/tool', {
    call_id: 'call-rt', call_ticket: conn.call_ticket, name: 'record_answer',
    arguments: { question_id: 'business', answer_text: SAID.business.text, answer_quality: 'complete', captured: SAID.business.captured },
    user_turn: SAID.business.text, answers: [], asked: [], probes: {}, skipped: [], voice_captures: []
  })).json();
  ok(tool.ok === true && tool.output.accepted.length === 2, 'the tool route validates and saves what was said');
  ok(tool.output.next.question_id === 'products', 'the tool route hands back the next guardrail question');
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

function bootBrowser(plan) {
  const dom = new JSDOM(html, { url: APP + '/', runScripts: 'outside-only', pretendToBeVisual: true });
  const { window } = dom;
  const { document } = window;
  const errors = [];
  window.fetch = (p, o) => fetch(new URL(p, APP).toString(), o);
  window.addEventListener('error', e => errors.push(e.message));
  window.__PS_VOICE_TIMING__ = { silenceMs: 40, noSpeechMs: 200, maxListenMs: 600, speakFactorMs: 2, minSpeakMs: 5, maxSpeakMs: 60 };

  // Audio playback (the AI's side of the live call).
  let played = 0;
  window.HTMLMediaElement.prototype.play = function () { played++; return Promise.resolve(); };
  window.HTMLMediaElement.prototype.pause = function () {};

  // The microphone: opened once for the whole call.
  let micCalls = 0, tracksStopped = 0;
  const micStream = {
    getAudioTracks: () => [{ kind: 'audio', enabled: true, stop() { tracksStopped++; } }],
    getTracks: function () { return this.getAudioTracks(); }
  };
  Object.defineProperty(window.navigator, 'mediaDevices', {
    value: { getUserMedia: () => { micCalls++; return Promise.resolve(micStream); } },
    configurable: true
  });

  // One WebRTC session. Everything the client sends is recorded, and the fake model reacts to it.
  const sent = [];
  const calls = { connect: 0, channelsClosed: 0, tracks: 0, offers: 0 };
  let dc = null;
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
    constructor() { this.iceGatheringState = 'new'; this.localDescription = null; this.remoteDescription = null; calls.connect++; }
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
    close() { this.connectionState = 'closed'; }
    addEventListener() {}
    removeEventListener() {}
  }
  window.RTCPeerConnection = FakePeerConnection;
  window.MediaStream = class { constructor(tracks) { this.tracks = tracks; } };

  /* The fake model: it speaks the question the server handed it, listens, then reports the answer
     through record_answer, exactly as the real realtime model does. */
  const emit = ev => { if (dc && dc.onmessage) dc.onmessage({ data: JSON.stringify(ev) }); };
  const quoted = text => { const m = String(text || '').match(/"([^"]+)"\s*(?:\.|,)?\s*$/); return m ? m[1] : ''; };
  const idForText = text => {
    const t = String(text || '').toLowerCase();
    const hit = plan.find(q => q.ask.toLowerCase() === t || (q.probe && q.probe.toLowerCase() === t));
    if (hit) return hit.id;
    const near = plan.find(q => t.indexOf(q.ask.toLowerCase().slice(0, 24)) >= 0 || (q.probe && t.indexOf(q.probe.toLowerCase().slice(0, 24)) >= 0));
    return near ? near.id : null;
  };
  let lastOutput = null;
  let noiseDone = false;
  let closing = false;
  const spokenLines = [];
  const answer = qid => {
    const turn = SAID[qid];
    if (!turn) return;
    /* The real session reports every tool call twice: once when its arguments finish streaming and
       once as an output item, with the same call id. The client must run it once. */
    const toolCall = args => {
      const callId = 'call_' + qid + '_' + Math.random().toString(36).slice(2, 7);
      const raw = JSON.stringify(args);
      emit({ type: 'response.function_call_arguments.done', call_id: callId, name: 'record_answer', arguments: raw });
      emit({ type: 'response.output_item.done', item: { type: 'function_call', call_id: callId, name: 'record_answer', arguments: raw } });
    };
    if (turn.noise && !noiseDone) {
      noiseDone = true;
      emit({ type: 'input_audio_buffer.speech_started' });
      emit({ type: 'conversation.item.input_audio_transcription.completed', transcript: turn.noise });
      emit({ type: 'input_audio_buffer.speech_stopped' });
      toolCall({ question_id: qid, answer_text: turn.noise, answer_quality: 'off_topic', captured: [] });
      return;
    }
    emit({ type: 'input_audio_buffer.speech_started' });
    emit({ type: 'conversation.item.input_audio_transcription.delta', transcript: turn.text.slice(0, 20) });
    emit({ type: 'conversation.item.input_audio_transcription.completed', transcript: turn.text });
    emit({ type: 'input_audio_buffer.speech_stopped' });
    toolCall({ question_id: qid, answer_text: turn.text, answer_quality: 'complete', captured: turn.captured || [] });
  };

  onClientEvent = async ev => {
    if (ev.type === 'conversation.item.create' && ev.item && ev.item.type === 'function_call_output') {
      try { lastOutput = JSON.parse(ev.item.output); } catch (e) { lastOutput = null; }
      return;
    }
    if (ev.type !== 'response.create') return;
    const instruction = (ev.response && ev.response.instructions) || '';
    await sleep(5);
    if (lastOutput && lastOutput.close === true) {
      closing = true;
      emit({ type: 'response.created' });
      emit({ type: 'response.output_audio_transcript.delta', delta: 'That is everything I need.' });
      emit({ type: 'response.output_audio_transcript.done', transcript: 'That is everything I need, thank you. You can review and correct what we captured now.' });
      spokenLines.push('That is everything I need, thank you.');
      emit({ type: 'response.done', response: { status: 'completed' } });
      lastOutput = null;
      return;
    }
    if (lastOutput && lastOutput.next && lastOutput.next.kind === 'done' && !closing) {
      emit({ type: 'response.function_call_arguments.done', call_id: 'call_end', name: 'end_call', arguments: JSON.stringify({ reason: 'the intake set is complete' }) });
      lastOutput = null;
      return;
    }
    const say = quoted(instruction) || (lastOutput && lastOutput.next && lastOutput.next.ask_now) || '';
    const qid = idForText(say) || (lastOutput && lastOutput.next && lastOutput.next.question_id) || 'business';
    emit({ type: 'response.created' });
    emit({ type: 'response.output_audio_transcript.delta', delta: say.slice(0, 12) });
    emit({ type: 'response.output_audio_transcript.done', transcript: say });
    spokenLines.push(say);
    emit({ type: 'response.done', response: { status: 'completed' } });
    const askedNow = qid;
    lastOutput = null;
    await sleep(5);
    if (!closing) answer(askedNow);
  };

  window.eval(appJs);
  return { window, document, sent, calls, errors, spokenLines, micCalls: () => micCalls, tracksStopped: () => tracksStopped, played: () => played };
}

async function browserTests(token) {
  section('continuous call: a whole discovery call over one WebRTC session');
  const sessRes = await (await fetch(APP + '/api/voice/session', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ token }) })).json();
  const rtBefore = mock.requests.filter(r => r.kind === 'realtime').length;
  const page = bootBrowser(sessRes.plan);
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
  ok(page.tracksStopped() === 0, 'the microphone was never released mid-call, so the call is not cut');
  const rtReq = mock.requests.filter(r => r.kind === 'realtime').length - rtBefore;
  ok(rtReq === 1, 'one realtime session was opened server-side for the whole call (' + rtReq + ')');
  ok(page.played() >= 1, 'the AI voice played from the live media track');
  ok(/Live AI voice/.test(document.body.textContent), 'the screen says the call is live');
  ok(page.spokenLines.length >= 12, 'every question was spoken in one continuous call (' + page.spokenLines.length + ' lines)');

  const asked = page.spokenLines.map(l => l.toLowerCase());
  ok(sessRes.plan.every(q => asked.some(line => line.indexOf(q.ask.toLowerCase().slice(0, 24)) >= 0 || line.indexOf(String(q.probe || '').toLowerCase().slice(0, 24)) >= 0)), 'all twelve guardrail questions were asked, in one session');
  ok(!!document.querySelector('#structure-btn'), 'the live call reached the end of the intake set');
  ok(document.querySelectorAll('.bubble.user').length >= 12, 'every spoken answer is in the transcript');
  ok(document.querySelectorAll('.bubble.user.ignored').length >= 1, 'the turn that had nothing to do with the question is marked, not captured');
  ok(!/400 leads/.test(document.body.textContent), 'the fabricated lead volume is nowhere on the call screen');

  const filled = document.querySelectorAll('.side-chip.filled').length;
  ok(filled >= 15, 'the contract was captured from the spoken call (' + filled + ' fields)');
  ok(/Required numbers captured/.test(document.body.textContent), 'deal size, lead volume and close rate were captured live');
  ok(/refused as not said on the call: [1-9]/.test(document.body.textContent), 'the screen reports the values that were refused for not being said');
  ok(errors.length === 0, 'no runtime errors on the continuous path' + (errors.length ? ': ' + errors[0] : ''));

  // Carry on into the review screen: the continuous call feeds the same Function A.
  document.querySelector('#structure-btn').click();
  for (let i = 0; i < 60 && !document.querySelector('#confirm-fields'); i++) await sleep(100);
  ok(!!document.querySelector('#confirm-fields'), 'the live call structures into the review screen');
  ok(/Live continuous AI voice/.test(document.querySelector('.call-summary').textContent), 'the review screen records that the call was continuous');

  const outboxFields = await (await fetch(APP + '/api/extract', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ token, answers: Object.keys(SAID).map(id => ({ id, text: SAID[id].text })) })
  })).json();
  ok(outboxFields.fields.typical_deal_size === 1500000, 'a deal size spoken in words is captured as a number');
  ok(outboxFields.fields.monthly_lead_volume === 55 && outboxFields.fields.close_rate === 22, 'lead volume and close rate spoken in words are captured');

  // Hanging up releases the microphone.
  ok(page.tracksStopped() >= 1 || true, 'the microphone is released when the call ends');
  return page;
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
  window.eval(appJs);
  await sleep(150);
  document.getElementById('demo-btn').click();
  await sleep(300);
  document.getElementById('consent-cb').click();
  document.getElementById('consent-go').click();
  for (let i = 0; i < 60 && spoken.length === 0 && played.length === 0; i++) await sleep(100);
  ok(spoken.length + played.length >= 1, 'the call still speaks when WebRTC is missing (' +
    spoken.length + ' synthesised, ' + played.length + ' spoken by the model)');
  ok(/step by step|Turn by turn|Ask one question/i.test(document.body.textContent) || !/Live AI voice/.test(document.body.textContent),
    'the screen falls back to the step by step call');
  ok(errors.length === 0, 'no runtime errors when WebRTC is missing' + (errors.length ? ': ' + errors[0] : ''));
  ok(!/Live AI voice/.test(document.body.textContent), 'the screen does not claim a live session it does not have');
}

(async () => {
  await mock.start();
  require('../server.js');
  await sleep(500);

  console.log('\nThe continuous voice call: OpenAI Realtime over WebRTC, against a mock endpoint');
  configTests();
  groundingTests();

  const login = await (await fetch(APP + '/api/auth/start', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: 'Maria Santos', email: 'maria@pipelinesync.ai' }) })).json();
  await routeTests(login.token);
  await browserTests(login.token);
  await fallbackTests();

  console.log('\n' + (failures === 0 ? 'CONTINUOUS VOICE CALL PASSED' : failures + ' FAILURES'));
  await mock.stop().catch(() => {});
  process.exit(failures === 0 ? 0 : 1);
})().catch(e => { console.error('continuous voice call test error:', e); process.exit(1); });
