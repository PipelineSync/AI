/* Drives the real frontend (public/app.js) through the voice-first journey in jsdom, hitting the
   real local server. Catches runtime JS errors the browser would hit, and proves the two rules:
     1. the AI speaks every line (browser voice or OpenAI audio) instead of chatting, and
     2. the call still captures the full Section 7 contract.
   A second scenario blocks the microphone and proves the "Type instead" fallback still works. */
const fs = require('fs');
const path = require('path');
const { JSDOM } = require('jsdom');
const { startServer } = require('./harness');
let BASE; // dedicated instance, started at the top of the scenario (test/harness.js)
const html = fs.readFileSync(path.join(__dirname, '..', 'public', 'index.html'), 'utf8')
  .replace(/<script src="app.js"><\/script>/, '');
const appJs = fs.readFileSync(path.join(__dirname, '..', 'public', 'app.js'), 'utf8');

const sleep = ms => new Promise(r => setTimeout(r, ms));
let failures = 0;
const ok = (cond, msg) => { console.log((cond ? '  PASS  ' : '  FAIL  ') + msg); if (!cond) failures++; };

/* Demo answers, mapped from whatever the AI just asked (so probes are answered too). */
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

/* A jsdom page wired the way the sandbox preview would be, with the microphone and voice faked. */
function boot(withMic) {
  const dom = new JSDOM(html, { url: BASE + '/', runScripts: 'outside-only', pretendToBeVisual: true });
  const { window } = dom;
  const { document } = window;
  const spoken = [];
  const errors = [];
  window.fetch = (p, o) => fetch(new URL(p, BASE).toString(), o);
  window.addEventListener('error', e => { errors.push(e.message); });
  window.__PS_VOICE_TIMING__ = { silenceMs: 50, noSpeechMs: 400, maxListenMs: 1500, speakFactorMs: 4, minSpeakMs: 10, maxSpeakMs: 120 };
  // Faked spoken voice: the AI can also receive OpenAI audio, in which case Audio fires onended.
  const speechTimes = [];
  window.SpeechSynthesisUtterance = class { constructor(text) { this.text = text; } };
  window.speechSynthesis = {
    getVoices() { return [{}]; },
    speak(u) { spoken.push(String(u.text)); speechTimes.push(Date.now()); setTimeout(() => { if (u.onend) u.onend(); }, 5); },
    cancel() {}
  };
  window.Audio = class {
    constructor(url) { this.url = url; }
    play() { setTimeout(() => { if (this.onended) this.onended(); }, 5); return Promise.resolve(); }
    pause() {}
  };
  // Faked microphone: answers whatever the AI just asked, then goes quiet.
  let lastKey = 'business';
  const answerNow = () => {
    const line = ((document.getElementById('ai-line') || {}).textContent || '').toLowerCase();
    for (const [frag, key] of QMAP) if (line.includes(frag)) { lastKey = key; break; }
    return SOLAR[lastKey];
  };
  window.__answerNow = answerNow;
  window.__spoken = spoken;
  window.__speechTimes = speechTimes;
  if (withMic) {
    window.SpeechRecognition = class {
      constructor() { this.lang = ''; this.interimResults = false; this.continuous = false; }
      start() { const self = this; setTimeout(() => { if (self.onresult) self.onresult({ resultIndex: 0, results: [Object.assign([{ transcript: answerNow() + ' ' }], { isFinal: true })] }); setTimeout(() => { if (self.onend) self.onend(); }, 20); }, 30); }
      stop() { if (this.onend) this.onend(); }
    };
  } else {
    delete window.SpeechRecognition;
    delete window.webkitSpeechRecognition;
    delete window.MediaRecorder;
    Object.defineProperty(window.navigator, 'mediaDevices', { value: undefined, configurable: true });
  }
  window.eval(appJs);
  return { window, document, spoken, errors, speechTimes };
}

/* The app opens on the entry gate: name + email, no password. Pass a name and email to go
   through it the way a client does, or use the demo account shortcut. */
async function passGate(page, details) {
  const { document, window } = page;
  await sleep(200);
  ok(!!document.querySelector('#st-name') && !!document.querySelector('#st-email'), 'the entry gate asks for a name and an email');
  ok(!document.querySelector('input[type=password]'), 'there is no password field: the login is gone');
  ok(!/\bLog in\b/.test(document.body.textContent), 'nothing on the gate says "Log in"');
  ok(/voice call/i.test(document.body.textContent), 'the gate says the next step is the AI voice call');
  ok(!!document.querySelector('#start-form button[type=submit]'), 'the gate has one submit action');
  const themeToggle = document.querySelector('#theme-toggle');
  const initialTheme = document.body.dataset.theme;
  ok(!!themeToggle && themeToggle.getAttribute('aria-label'), 'the colour-mode switch is available and labelled');
  if (themeToggle) {
    themeToggle.click();
    await sleep(20);
    ok(document.body.dataset.theme !== initialTheme && document.querySelector('#theme-toggle').getAttribute('aria-pressed') === 'true',
      'the colour-mode switch changes to light mode');
    document.querySelector('#theme-toggle').click();
    await sleep(20);
  }

  if (details) {
    // An empty gate must not start a call: the error is inline and the client stays put.
    document.getElementById('start-form').dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true }));
    await sleep(150);
    ok(!!document.querySelector('#st-name') && !document.querySelector('#consent-go'), 'an empty gate does not start the call');
    ok(!document.getElementById('start-error').hidden, 'the gate explains what is missing');
    document.getElementById('st-name').value = details.name;
    document.getElementById('st-email').value = details.email;
    document.getElementById('start-form').dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true }));
  } else {
    document.getElementById('demo-btn').click();
  }
  await sleep(700);   // the notice is read while the voice layer warms up
  ok(!!document.querySelector('#consent-go'), 'consent screen after the entry gate');
  return page;
}

async function reachCall(page, details) {
  const { document, spoken, speechTimes, window } = page;
  await passGate(page, details);
  const signedInTheme = document.querySelector('.theme-switch-top .theme-toggle');
  ok(!!signedInTheme && signedInTheme.getAttribute('aria-label') === 'Switch to light mode',
    'the signed-in dashboard has a contextual colour-mode switch');
  if (signedInTheme) {
    signedInTheme.click();
    await sleep(20);
    const lightTheme = document.querySelector('.theme-switch-top .theme-toggle');
    ok(document.body.dataset.theme === 'light' && lightTheme && lightTheme.getAttribute('aria-pressed') === 'true' &&
      lightTheme.getAttribute('aria-label') === 'Switch to dark mode' && window.localStorage.getItem('ps_theme') === 'light',
      'the signed-in switch changes and persists light mode');
    lightTheme.click();
    await sleep(20);
  }
  ok(/OpenAI for the voice call/.test(document.body.textContent), 'disclaimer names the OpenAI voice layer');
  ok(/starts speaking/i.test(document.getElementById('consent-note').textContent), 'the consent screen says the AI starts speaking on agreement');
  ok(/Agree and start the voice call/.test(document.getElementById('consent-go').textContent), 'the button that agrees to the disclaimer is the one that starts the call');

  // Agreeing to the disclaimer is the gesture that starts the call: the AI speaks from here, with
  // no separate start button and no text box.
  const agreedAt = Date.now();
  document.getElementById('consent-cb').click();
  document.getElementById('consent-go').click();
  await sleep(300);
  ok(spoken.length >= 1, 'the AI started speaking as soon as the disclaimer was agreed');
  ok(!document.querySelector('#start-call'), 'no second start button: the call began on agreement');
  const micAvailable = !!(page.window.SpeechRecognition || page.window.MediaRecorder);
  ok(micAvailable ? !document.querySelector('#intake-input') : !!document.querySelector('#intake-input'),
    micAvailable ? 'no text box: the call is voice from the start' : 'with no microphone at all the typed fallback appears by itself');
  page.speakDelay = (speechTimes[0] || Infinity) - agreedAt;
  ok(page.speakDelay < 400, 'the AI voice begins on agreement, without waiting for the network (' + page.speakDelay + ' ms)');
}

/* ------------------------------------------------------------------ */
(async () => {
  const srv = await startServer(8093);
  BASE = srv.base;
  process.on('exit', () => srv.stop());
  console.log('\nScenario 1: a voice discovery call (microphone present)');
  const p1 = boot(true);
  await reachCall(p1, { name: 'Maria Santos', email: 'maria@solarworks.ph' });
  ok(/Maria Santos/.test(p1.document.body.textContent) || /Maria/.test(p1.document.body.textContent),
    'the header shows who is on the call after the entry gate');
  const d1 = p1.document;

  ok(!!d1.querySelector('#mic-btn') || !!d1.querySelector('#type-btn'), 'the in-call controls are on screen straight after agreement');
  ok(p1.spoken.length >= 1, 'the AI spoke its first line out loud (' + JSON.stringify((p1.spoken[0] || '').slice(0, 60)) + '...)');
  ok(/what do you do/i.test(p1.spoken[0] || ''), 'the first spoken line asks the opening question');
  ok(/PipelineSync/.test(p1.spoken[0] || ''), 'the AI introduces itself on the first line (AI disclosure on the call)');
  ok(/ChatGPT voice|Simulated voice/.test(d1.body ? d1.body.textContent : d1.body.textContent), 'the screen states which voice provider is live');
  ok(!!d1.querySelector('.orb.listening, .orb.speaking, .orb.thinking, .orb.ready'), 'the call UI shows the live call state');

  for (let i = 0; i < 40 && !d1.querySelector('#structure-btn'); i++) await sleep(250);
  ok(!!d1.querySelector('#structure-btn'), 'the AI worked through the intake set and closed the call');
  ok(p1.spoken.length >= 12, 'the AI spoke every question (' + p1.spoken.length + ' lines)');
  ok(d1.querySelectorAll('.bubble.user').length >= 12, 'the transcript holds the spoken answers');
  ok(d1.querySelectorAll('.bubble.ai').length >= 12, 'the transcript holds the AI lines');
  const details = d1.querySelector('#transcript-wrap');
  ok(!!details && !details.open, 'the transcript stays collapsed: the call is voice, not chat');
  ok(d1.querySelectorAll('.side-chip.filled').length >= 15, 'the sidebar shows captured values (' + d1.querySelectorAll('.side-chip.filled').length + ' fields)');
  ok(/Required numbers captured/.test(d1.body.textContent), 'deal size, lead volume and close rate were captured live');
  ok(p1.errors.length === 0, 'no runtime errors during the voice call' + (p1.errors.length ? ': ' + p1.errors[0] : ''));

  // hand-off to Function A and the rest of the journey
  d1.getElementById('structure-btn').click();
  await sleep(3200);
  ok(!!d1.querySelector('#confirm-fields'), 'review screen rendered from the call transcript');
  ok(/ChatGPT voice|Simulated voice/.test(d1.querySelector('.call-summary').textContent), 'the review screen records how the call was run');
  const nullBadges = d1.querySelectorAll('.nullbadge').length;
  console.log('  (review shows ' + nullBadges + ' "Not stated" badges)');
  const reviewInputs = Array.from(d1.querySelectorAll('[data-key], [data-prod], [data-src]'))
    .filter(el => el.tagName === 'INPUT');
  ok(reviewInputs.length > 0 && reviewInputs.every(el => el.type === 'text' || el.type === 'number'),
    'review inputs declare a native type so the design-system controls are styled');
  ok(Array.from(d1.querySelectorAll('input[data-type="number"]')).every(el => el.type === 'number'),
    'review numeric fields use numeric inputs and the numeric keypad');

  d1.getElementById('confirm-fields').click();
  // Phase 2: generation is a real background job. The loader must show a state the
  // server actually reported, and the blueprint must not appear before it is done.
  await sleep(500);
  const loaderStep = d1.querySelector('#loader-step');
  ok(!!loaderStep, 'the generation loader shows a progress state');
  ok(!d1.querySelector('.doc'), 'the blueprint is not rendered while the job is still running');
  for (let i = 0; i < 60 && !d1.querySelector('.doc'); i++) await sleep(250);
  
  ok(!!d1.querySelector('.doc'), 'blueprint document rendered only after the API reported done');
  ok(!!d1.querySelector('.coa-item'), 'cost of inaction items rendered');
  ok(d1.querySelectorAll('.chip.kb').length > 5, 'KB reference chips rendered');
  ok(!d1.querySelector('.doc').textContent.includes('\u2014'), 'no em dashes in the blueprint view');

  d1.getElementById('unlock-btn').click();
  await sleep(100);
  d1.getElementById('un-consent').click();
  d1.getElementById('un-go').click();
  await sleep(1400);
  ok(!!d1.querySelector('.success-card'), 'delivery success card shown');
  ok(/PDF ready/.test(d1.body.textContent), 'success card reports the PDF is ready');
  ok(!/pushed to HubSpot/.test(d1.body.textContent), 'mocked deliver does not claim a HubSpot push');

  const outboxRaw = await (await fetch(BASE + '/dev/outbox')).text();
  // The outbox JSON is HTML-escaped (hardening), so decode it before asserting on the payload.
  const outbox = outboxRaw.replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
  ok(/&quot;voice_call&quot;/.test(outboxRaw), 'the outbox escapes the payload it prints (hardening kept)');
  ok(/"voice_call"/.test(outbox), 'the lead carries the voice call metadata (voice_call block)');
  ok(/"audio_retained": false/.test(outbox), 'the lead records that no audio was retained');
  ok(/"turns": \d+/.test(outbox), 'the lead records how many turns the call took');

  d1.getElementById('book-btn').click();
  await sleep(200);
  const dayBtn = d1.querySelector('[data-day]');
  ok(!!dayBtn, 'booking screen rendered with days');
  dayBtn.click();
  await sleep(150);
  d1.querySelectorAll('[data-slot]')[1].click();
  await sleep(150);
  d1.getElementById('book-go').click();
  await sleep(150);
  ok(d1.body.textContent.includes('Meeting requested'), 'meeting requested state');
  d1.getElementById('finish-btn').click();
  await sleep(150);
  ok(d1.body.textContent.includes('Your blueprint is on its way'), 'done screen rendered');

  console.log('\nScenario 2: microphone blocked (preview iframe, no speech recognition)');
  const p2 = boot(false);
  await reachCall(p2);
  ok(!!p2.document.querySelector('#side-toggle'), 'the captured-answers panel is reachable on a narrow screen');
  const d2 = p2.document;
  await sleep(600);
  ok(p2.spoken.length >= 1, 'the AI speaks even when the microphone is blocked');
  ok(/blocked|Type instead/i.test(d2.body.textContent), 'the blocked microphone is explained with the Type instead route');
  ok(!!d2.querySelector('#intake-input'), 'typing is offered when the microphone cannot be used');
  ok(p2.spoken.length >= 1, 'the AI still speaks the questions (browser voice)');
  ok(!d2.querySelector('#transcript-wrap').open, 'the transcript is still collapsed');

  // Type the answers instead, the way a client with a blocked mic would.
  for (let i = 0; i < 80 && !d2.querySelector('#structure-btn'); i++) {
    const inp = d2.querySelector('#intake-input');
    if (inp && !inp.disabled) {
      inp.value = p2.window.__answerNow();
      d2.getElementById('send-btn').click();
    }
    await sleep(300);
  }
  ok(!!d2.querySelector('#structure-btn'), 'the typed journey still reaches the end of the call');
  ok(d2.querySelectorAll('.bubble.user').length >= 12, 'typed answers land in the same transcript');
  d2.getElementById('structure-btn').click();
  await sleep(3200);
  ok(!!d2.querySelector('#confirm-fields'), 'typed answers structure into the review screen');
  ok(p2.errors.length === 0, 'no runtime errors in the typed fallback' + (p2.errors.length ? ': ' + p2.errors[0] : ''));

  console.log('\n' + (failures === 0 ? 'UI SMOKE TEST PASSED' : failures + ' UI FAILURES'));
  process.exit(failures === 0 ? 0 : 1);
})().catch(e => { console.error('UI smoke error:', e); process.exit(1); });
