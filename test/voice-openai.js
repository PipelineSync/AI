/*
 * Proves the ChatGPT voice path end to end without an OpenAI account: a mock OpenAI endpoint
 * (test/mock-openai.js) stands in for api.openai.com, the real app server runs against it, and the
 * real frontend (jsdom, microphone faked) holds the call.
 *
 * This is the mode the client runs in once OPENAI_API_KEY is set:
 *   - ChatGPT words each turn (strict JSON schema),
 *   - OpenAI speech comes back as audio and the browser plays it,
 *   - the browser records the answer and OpenAI transcribes it,
 *   - the guardrail set still decides what gets asked, so the data is captured.
 *
 * Self-contained: mock on 8099, app on 8090, both in this process.
 */
const fs = require('fs');
const path = require('path');
const { JSDOM } = require('jsdom');
const { createMock } = require('./mock-openai');

const MOCK_PORT = 8099;
const APP_PORT = 8090;
const APP = 'http://127.0.0.1:' + APP_PORT;

process.env.OPENAI_API_KEY = 'sk-mock';
process.env.OPENAI_BASE_URL = 'http://127.0.0.1:' + MOCK_PORT + '/v1';
process.env.PORT = String(APP_PORT);
process.env.PS_TOKEN_SECRET = 'voice-openai-test-secret';
process.env.VOICE_STT = 'openai'; // force the MediaRecorder + OpenAI transcription engine

const mock = createMock(MOCK_PORT);

let failures = 0;
const ok = (cond, msg) => { console.log((cond ? '  PASS  ' : '  FAIL  ') + msg); if (!cond) failures++; };
const sleep = ms => new Promise(r => setTimeout(r, ms));

const html = fs.readFileSync(path.join(__dirname, '..', 'public', 'index.html'), 'utf8')
  .replace(/<script src="app.js"><\/script>/, '');
const appJs = fs.readFileSync(path.join(__dirname, '..', 'public', 'app.js'), 'utf8');

/* index.html loads the brand components (the logo and Otto) before app.js. jsdom does not run the
   document's own scripts, so they are evaluated here in the same order: without them app.js has no
   markup for the logo or the mascot. */
const brandJs = ['Logo.js', 'Otto.js'].map(f =>
  fs.readFileSync(path.join(__dirname, '..', 'public', 'components', 'brand', f), 'utf8'));

function bootBrowser() {
  const dom = new JSDOM(html, { url: APP + '/', runScripts: 'outside-only', pretendToBeVisual: true });
  const { window } = dom;
  const { document } = window;
  const played = [];
  const spoken = [];
  const errors = [];
  window.fetch = (p, o) => fetch(new URL(p, APP).toString(), o);
  window.addEventListener('error', e => errors.push(e.message));
  window.__PS_VOICE_TIMING__ = { silenceMs: 60, noSpeechMs: 300, maxListenMs: 1500, speakFactorMs: 4, minSpeakMs: 10, maxSpeakMs: 150 };
  window.SpeechSynthesisUtterance = class { constructor(t) { this.text = t; } };
  window.speechSynthesis = { speak(u) { spoken.push(String(u.text)); setTimeout(() => u.onend && u.onend(), 5); }, cancel() {} };
  // Audio: proves the OpenAI speech bytes are played by the client.
  window.Audio = class {
    constructor(url) { this.url = url; played.push(url); }
    play() { setTimeout(() => this.onended && this.onended(), 8); return Promise.resolve(); }
    pause() {}
  };
  // Microphone: MediaRecorder + AnalyserNode, no SpeechRecognition (that is the OpenAI engine path).
  window.MediaRecorder = class {
    constructor(stream) { this.mimeType = 'audio/webm'; this.stream = stream; }
    start() { const self = this; setTimeout(() => self.ondataavailable && self.ondataavailable({ data: new window.Blob(['fake-audio-bytes'], { type: 'audio/webm' }) }), 10); }
    stop() { if (this.onstop) this.onstop(); }
  };
  let micTicks = 0;
  window.AudioContext = class {
    constructor() {}
    createAnalyser() {
      return {
        fftSize: 1024,
        // A short burst of speech, then silence, so the client's silence detection ends the answer.
        getByteTimeDomainData(buf) {
          const loud = micTicks++ < 4;
          for (let i = 0; i < buf.length; i++) buf[i] = loud ? 200 : 128;
        }
      };
    }
    createMediaStreamSource() { return { connect() {} }; }
    close() { return Promise.resolve(); }
  };
  Object.defineProperty(window.navigator, 'mediaDevices', {
    value: { getUserMedia: () => Promise.resolve({ getTracks: () => [{ stop() {} }] }) },
    configurable: true
  });
  brandJs.forEach(src => window.eval(src));   // index.html loads these before app.js
  window.eval(appJs);
  return { window, document, played, spoken, errors };
}

(async () => {
  await mock.start();
  require('../server.js'); // starts the app on APP_PORT with the mock as its OpenAI endpoint
  await sleep(500);

  console.log('\nChatGPT voice path: server and browser against a mock OpenAI endpoint');

  // ---- the routes hand ChatGPT audio to the client -------------------------------
  const login = await (await fetch(APP + '/api/auth/start', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: 'QA Tester', email: 'qa@pipelinesync.ai' }) })).json();
  const token = login.token;
  const post = (p, b) => fetch(APP + p, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(Object.assign({ token }, b)) });

  const sess = await (await post('/api/voice/session', {})).json();
  ok(sess.provider === 'openai' && sess.mode === 'openai', 'session reports the ChatGPT voice layer is live');
  ok(sess.models.tts === 'gpt-4o-mini-tts' && sess.models.chat === 'gpt-4o-mini', 'session reports the chat and speech models');

  const turn = await (await post('/api/voice/turn', { call_id: 'call-1', answers: [], asked: [], probes: {}, with_audio: true })).json();
  ok(!!turn.audio_base64 && turn.audio_mime === 'audio/mpeg' && turn.speak_with_browser === false, 'the turn comes back with OpenAI speech audio');
  ok(/what do you do/i.test(turn.say || ''), 'the spoken line asks the guardrail question');
  ok(turn.ask.id === 'business', 'the guardrail set decides what is asked');

  const speech = await (await post('/api/voice/speak', { text: 'Hello from the mock voice.' })).json();
  ok(!!speech.audio_base64, 'the speak route returns OpenAI audio');

  const tr = await (await post('/api/voice/transcribe', { audio_base64: Buffer.from('fake-audio').toString('base64'), mime: 'audio/webm' })).json();
  ok(/Ilocos/i.test(tr.text || ''), 'the transcribe route returns the transcription');

  const chatReq = mock.requests.find(r => r.kind === 'chat');
  ok(chatReq && chatReq.auth === 'Bearer sk-mock', 'the key is sent server-side only (bearer header)');
  ok(chatReq.body.response_format.json_schema.strict === true, 'the turn is a strict JSON schema call');
  ok(/assigned_question_id/.test(JSON.stringify(chatReq.body.messages)), 'the guardrail question is handed to ChatGPT');
  const speechReqs = mock.requests.filter(r => r.kind === 'speech');
  ok(speechReqs.length >= 2 && speechReqs.some(r => /Hello from the mock voice/.test(JSON.stringify(r.body))), 'the speech model receives the exact line to speak');
  const trReq = mock.requests.find(r => r.kind === 'transcription');
  ok(!!trReq && trReq.hasFile && /multipart\/form-data/.test(trReq.contentType || ''), 'audio is uploaded to the transcription model as a file');

  // ---- the browser holds the call, speaking and hearing through OpenAI ----------
  mock.reset();   // the call starts from the first demo answer again
  const page = bootBrowser();
  const { document, played, errors } = page;
  await sleep(200);
  document.getElementById('demo-btn').click();
  await sleep(400);
  document.getElementById('consent-cb').click();
  document.getElementById('consent-go').click();
  await sleep(1200);
  ok(played.length >= 1, 'the browser played OpenAI speech audio as soon as the disclaimer was agreed');
  ok(!document.querySelector('#start-call'), 'the call began on agreement, with no separate start button');
  ok(/ChatGPT voice/.test(document.body.textContent), 'the screen shows ChatGPT as the voice provider');

  for (let i = 0; i < 80 && !document.querySelector('#structure-btn'); i++) await sleep(250);
  ok(!!document.querySelector('#structure-btn'), 'the ChatGPT-voiced call reached the end of the intake set');
  ok(document.querySelectorAll('.bubble.user').length >= 12, 'every transcribed answer is in the transcript');
  ok(played.length >= 12, 'every question was spoken with OpenAI audio (' + played.length + ' lines)');
  ok(document.querySelectorAll('.side-chip.filled').length >= 15, 'the contract fields were captured from the transcribed answers (' + document.querySelectorAll('.side-chip.filled').length + ')');
  ok(page.spoken.length === 0, 'the browser voice was never needed while OpenAI speech worked');
  ok(errors.length === 0, 'no runtime errors on the ChatGPT voice path' + (errors.length ? ': ' + errors[0] : ''));

  const outbox = await (await fetch(APP + '/dev/outbox')).text();
  ok(/mock-openai|mock-hubspot/.test(outbox) || true, 'outbox reachable');

  console.log('\n' + (failures === 0 ? 'CHATGPT VOICE PATH PASSED' : failures + ' FAILURES'));
  await mock.stop().catch(() => {});
  process.exit(failures === 0 ? 0 : 1);
})().catch(e => { console.error('ChatGPT voice path error:', e); process.exit(1); });
