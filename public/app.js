(function () {
'use strict';
/*
 * PipelineSync AI - prototype frontend (vanilla JS, no CDN, works offline in preview)
 * Production version of this layer is React on Netlify; the flow and data contract
 * are identical, only the rendering technology changes.
 */

const $ = s => document.querySelector(s);
const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const fmtMoney = v => v == null || v === '' ? '' : 'PHP ' + Number(v).toLocaleString('en-PH');
const sleep = ms => new Promise(r => setTimeout(r, ms));
// "about 1.5 million" -> 1500000, "22 percent" -> 22, "PHP 80,000" -> 80000
function looseNumber(raw) {
  const t = String(raw == null ? '' : raw).toLowerCase().replace(/,/g, '');
  const m = t.match(/(\d+(?:\.\d+)?)\s*(k|thousand|m|million)?/);
  if (!m) return null;
  let n = parseFloat(m[1]);
  if (!Number.isFinite(n)) return null;
  if (m[2] === 'k' || m[2] === 'thousand') n *= 1000;
  if (m[2] === 'm' || m[2] === 'million') n *= 1000000;
  return n;
}
// Safe storage: the preview iframe can run sandboxed without allow-same-origin,
// where localStorage throws. Fall back to in-memory so the app still works.
const memStore = {};
const store = {
  get: k => { try { return window.localStorage.getItem(k); } catch (e) { return memStore[k] != null ? memStore[k] : null; } },
  set: (k, v) => { try { window.localStorage.setItem(k, v); } catch (e) { memStore[k] = v; } }
};

/* The 12-question interview plan, the field labels and the three required fields all live in
   lib/voice.js and arrive from /api/voice/session, so the voice layer and the screen cannot drift
   apart. The QA personas below are demo answers keyed by the same question ids. */

/* QA personas covering the four verticals in the brief (Section 9 brain-quality test) */
const PERSONAS = {
  solar: { label: 'Solar installer (demo)', answers: {
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
  }},
  medical: { label: 'Dental clinic (demo)', answers: {
    business: 'We run a dental clinic in Ilocos with four chairs and general plus cosmetic dentistry.',
    products: 'General check-up at 1,500 pesos\nWhitening at 8,000 pesos, after an evaluation\nImplants at 45,000 pesos, after an x-ray and treatment plan',
    deal: 'About 6,000 a typical deal, and two people take calls',
    fulfilment: 'Four dentists and two assistants, we deliver everything in-house',
    owner: 'My operations manager, Rosa',
    close: 'One call, they book the first visit straight away',
    sources: 'Google about 30 a month, tracked\nReferrals about 12 a month, not tracked\nWalk-ins about 40 a month, not tracked',
    capture: 'We book in Excel and take messages on WhatsApp, no CRM',
    volumes: '80 leads a month, we close about 60, so roughly 75 percent, and the cycle is two weeks',
    spend: '30,000 on Google and a bit of Facebook, 5,000 on software',
    headache: 'No-shows and no follow-up, so people book and then disappear',
    goal: '30 percent more bookings and fewer no-shows'
  }},
  home: { label: 'HVAC and plumbing (demo)', answers: {
    business: 'We do aircon and plumbing service and installation for homes in and around Ilocos.',
    products: 'AC service at 2,500 pesos\nAC installation at 18,000 pesos\nPlumbing repair at 1,800 pesos',
    deal: 'Around 12,000 a typical job, four people take calls',
    fulfilment: 'Eight technicians, our own team does all the work',
    owner: 'Me, and my brother handles the jobs',
    close: 'Two calls usually. One to quote, one to confirm the slot',
    sources: 'Website about 35 a month, tracked\nPhone calls about 50 a month, not tracked\nReferrals about 10 a month, not tracked',
    capture: 'Paper and WhatsApp, no CRM at all',
    volumes: '90 leads a month, we finish about 18 jobs, so 20 percent, and a week from call to job',
    spend: '25,000 on Google, 3,000 on software',
    headache: 'We miss calls all the time and I have no idea how many jobs are in the pipeline',
    goal: '25 completed jobs a month'
  }},
  ecommerce: { label: 'Coffee e-commerce (demo)', answers: {
    business: 'We sell single-origin coffee online in the Philippines, mostly subscriptions and hampers.',
    products: 'Subscription box at 950 pesos a month\nSingle-origin bag at 450 pesos\nCorporate hampers at 3,500 pesos',
    deal: 'About 1,200 a typical order, one person handles the phone',
    fulfilment: 'Five people, we pack and ship from our own warehouse',
    owner: 'I handle marketing and operations',
    close: 'One call, and most orders are self-checkout online',
    sources: 'Instagram about 200 a month, tracked\nGoogle about 80 a month, tracked\nEmail about 120 a month, tracked',
    capture: 'Shopify and Mailchimp, no real CRM',
    volumes: '400 leads a month, we convert about 150, so roughly 38 percent, and it is same week',
    spend: '60,000 on ads, 10,000 on software',
    headache: 'Repeat purchase is flat, so everything depends on new customers',
    goal: '30 percent more revenue in six months'
  }}
};

/* field labels for the progress sidebar (matches the Section 7 data contract) */
const FIELD_LABELS = {
  industry: 'Industry', business_description: 'Business description', products: 'Products and prices',
  typical_deal_size: 'Typical deal size', sales_reps_on_calls: 'Reps on calls', fulfilment_headcount: 'Fulfilment headcount',
  marketing_ops_owner: 'Marketing ops owner', close_type: 'Close type', sales_process_notes: 'Process notes',
  lead_sources: 'Lead sources', lead_capture_method: 'Capture method', current_crm: 'Current CRM',
  current_hubspot_tier: 'HubSpot tier', current_tools: 'Current tools', monthly_lead_volume: 'Monthly lead volume',
  monthly_deal_volume: 'Monthly deal volume', close_rate: 'Close rate', sales_cycle_length: 'Sales cycle',
  biggest_headache: 'Biggest headache', six_month_goal: 'Six-month goal', monthly_marketing_spend: 'Marketing spend',
  monthly_software_budget: 'Software budget', fulfilment_method: 'Fulfilment method'
};
const REQUIRED = ['typical_deal_size', 'monthly_lead_volume', 'close_rate'];

/* ---------------- state ---------------- */
const state = {
  token: store.get('ps_token') || null,
  user: JSON.parse(store.get('ps_user') || 'null'),
  stage: 'login',
  answers: [],           // [{id, text}] captured on the call (or by typing)
  fields: null,          // Section 7 contract
  blueprint: null,
  delivered: null,       // {contact_id, filename, pdf_url}
  booking: null,         // {day, slot}
  fieldStatus: {},       // live sidebar state
  voice: null,           // live call state (see newVoiceState in the voice engine)
  showTranscript: false  // transcript panel is collapsed; the call is spoken
};
function saveAuth() {
  store.set('ps_token', state.token || '');
  store.set('ps_user', JSON.stringify(state.user || {}));
}
function resetJourney() {
  stopSpeaking(); stopListening();
  state.stage = 'consent'; state.answers = []; state.fields = null;
  state.blueprint = null; state.delivered = null; state.booking = null; state.fieldStatus = {};
  state.voice = null; state.showTranscript = false;
}

/* ---------------- api ---------------- */
const api = {
  async post(p, body) {
    const r = await fetch(p, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(Object.assign({ token: state.token }, body)) });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) {
      if (r.status === 401) { state.token = null; state.user = null; saveAuth(); state.stage = 'login'; render(); }
      throw new Error(j.error || 'HTTP ' + r.status);
    }
    return j;
  }
};

/* ---------------- toast ---------------- */
let toastTimer = null;
function toast(msg, isErr) {
  const t = $('#toast');
  t.textContent = msg;
  t.className = 'toast show' + (isErr ? ' err' : '');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { t.className = 'toast'; }, 3800);
}

/* ---------------- voice engine (ChatGPT voice discovery call) ----------------
 * The call is voice-first: the AI speaks every line out loud, the client answers with their
 * voice, and the transcript stays collapsed behind a link. Text input lives behind "Type
 * instead", so a blocked microphone never locks anyone out of the journey.
 *
 * Speech out : audio returned by /api/voice/turn (OpenAI speech, key server-side).
 *              In simulated mode (no key) the browser voice reads the line.
 * Speech in  : the browser recogniser when the browser has one (free, instant, live words),
 *              otherwise MediaRecorder -> /api/voice/transcribe (OpenAI transcription).
 *
 * Timings are tunable (useful for tuning silence detection, and for tests):
 *   window.__PS_VOICE_TIMING__ = { silenceMs, noSpeechMs, maxListenMs, speakFactorMs }
 */
const TIMING = Object.assign({
  silenceMs: 1900,       // quiet for this long after speech -> the answer is done
  noSpeechMs: 9000,      // nothing at all -> ask again
  maxListenMs: 25000,    // hard stop for one answer
  speakFactorMs: 330,    // ms per word, used to size the spoken-line watchdog
  minSpeakMs: 900,
  maxSpeakMs: 30000,
  levelThreshold: 0.02   // mic level that counts as speech (MediaRecorder engine)
}, window.__PS_VOICE_TIMING__ || {});

const VOICE_STATUS_TEXT = {
  idle: 'Ready when you are. Start the call and answer out loud, like a phone call.',
  connecting: 'Connecting the AI interviewer...',
  thinking: 'Thinking about what you said...',
  speaking: 'The AI is speaking. Listen, then answer when it stops.',
  listening: 'Listening. Answer in your own words, then pause when you are done.',
  ready: 'Your turn. Tap the microphone and answer out loud, or type instead.',
  complete: 'That is the call. Review what we captured, then structure the answers.',
  error: 'The call hit a problem. You can retry the turn, or carry on by typing.'
};

function newVoiceState() {
  return {
    cfg: null, plan: [], provider: null, mode: null, why: '',
    status: 'idle', transcript: [], asked: [], probes: {}, captures: [],
    callId: 'call-' + Math.random().toString(36).slice(2, 10), callTicket: null, turns: 0,
    startedAt: null, endedAt: null, currentQuestionId: null, pendingQuestionId: null,
    lastLine: '', interim: '', lastHeard: '', error: null, notice: null,
    micBlocked: false, engine: null, handsFree: true, muted: false, typed: false,
    speaking: false, listening: false, capture: null, done: false, warnings: [],
    audioEl: null, stopListening: null, rec: null, skipped: [], stopSpeakHook: null,
    opening: null, prefetching: false, prefetchTried: false, prefetchPromise: null,
    sessionPromise: null, sessionError: null, blockedAudio: null, retryArmed: false
  };
}

function voiceSync() { return state.voice || (state.voice = newVoiceState()); }

/* Prefetchable session: same call, no status line change, safe to fire while the screen renders. */
function ensureSessionSilent() {
  const v = voiceSync();
  if (v.cfg) return Promise.resolve(v.cfg);
  if (v.sessionPromise) return v.sessionPromise;
  v.sessionPromise = api.post('/api/voice/session', {}).then(j => {
    v.cfg = j; v.plan = j.plan || []; v.provider = j.provider; v.mode = j.mode; v.why = j.why;
    v.sessionPromise = null; render();
    return j;
  }).catch(e => { v.sessionPromise = null; v.sessionError = e.message; throw e; });
  return v.sessionPromise;
}

/* True once the voice layer is warm, so the screen can promise the AI speaks on agree. */
function voiceReady() {
  const v = voiceSync();
  return !!(v.opening || v.cfg);
}
/* Agreeing to the disclaimer is the gesture that starts the call: the screen changes and the AI
   speaks straight away, picking up the opening line that was prefetched while the notice was read. */
function beginCall() {
  state.stage = 'intake';
  render();
  startCall();
}

async function ensureSession() {
  const v = voiceSync();
  if (v.cfg) return v.cfg;
  v.status = 'connecting'; v.error = null; render();
  try {
    const j = await api.post('/api/voice/session', {});
    v.cfg = j; v.plan = j.plan || []; v.provider = j.provider; v.mode = j.mode; v.why = j.why;
    v.capture = state.voice.capture;
    v.status = 'idle';
    return j;
  } catch (e) {
    v.status = 'error'; v.error = e.message; render();
    throw e;
  }
}

/* ---------------- speaking ---------------- */
function speechMs(text) {
  const words = String(text || '').trim().split(/\s+/).filter(Boolean).length;
  return Math.max(TIMING.minSpeakMs, Math.min(TIMING.maxSpeakMs, Math.round(words * TIMING.speakFactorMs)));
}
function playAudio(b64, mime) {
  return new Promise((resolve, reject) => {
    let url, a, revoke = false;
    try {
      const type = mime || 'audio/mpeg';
      const bin = atob(b64);
      const bytes = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
      try {
        if (window.URL && URL.createObjectURL) { url = URL.createObjectURL(new Blob([bytes], { type: type })); revoke = true; }
      } catch (e) { url = null; }
      if (!url) url = 'data:' + type + ';base64,' + b64;   // no createObjectURL (jsdom, some webviews)
      a = new Audio(url);
    } catch (e) { return reject(e); }
    voiceSync().audioEl = a;
    let settled = false;
    const finish = ok => {
      if (settled) return; settled = true;
      clearTimeout(guard);
      try { a.pause(); } catch (e) {}
      try { if (revoke) URL.revokeObjectURL(url); } catch (e) {}
      ok ? resolve() : reject(new Error('autoplay-blocked'));
    };
    const guard = setTimeout(() => finish(true), speechMs(state.voice.lastLine) + 15000);
    a.onended = () => finish(true);
    a.onerror = () => reject(new Error('audio-error'));
    voiceSync().stopSpeakHook = () => finish(true);
    try {
      const p = a.play();
      if (p && typeof p.catch === 'function') p.catch(() => { voiceSync().blockedAudio = { b64: b64, mime: mime || 'audio/mpeg' }; finish(false); });
    } catch (e) { finish(false); }
  });
}
function speakWithBrowser(text) {
  return new Promise(resolve => {
    const sy = window.speechSynthesis;
    const Utter = window.SpeechSynthesisUtterance;
    const deadline = speechMs(text);
    if (!sy || !Utter) { setTimeout(resolve, Math.min(deadline, 1400)); return; } // no browser voice: subtitles carry the line
    let settled = false;
    const finish = () => { if (settled) return; settled = true; clearTimeout(guard); resolve(); };
    const guard = setTimeout(finish, deadline + 4000);
    const say = () => {
      if (settled) return;
      try {
        const u = new Utter(text);
        u.lang = (state.voice.cfg && state.voice.cfg.locale) || 'en-PH';
        u.rate = 1; u.pitch = 1; u.volume = 1;
        u.onend = finish; u.onerror = finish;
        voiceSync().stopSpeakHook = finish;
        sy.speak(u);
        // Chrome drops the very first utterance while its voice list is still loading: retry once.
        setTimeout(() => {
          if (settled) return;
          const idle = sy.speaking === false && (sy.pending === false || sy.pending === undefined);
          if (idle) { try { sy.cancel(); sy.speak(new Utter(text)); } catch (e) { finish(); } }
        }, 1000);
      } catch (e) { finish(); }
    };
    try {
      if (!sy.getVoices || sy.getVoices().length) return say();
      let done = false;
      const t = setTimeout(() => { if (!done) { done = true; say(); } }, 700);   // voices never arrived: speak anyway
      sy.onvoiceschanged = () => { if (!done) { done = true; clearTimeout(t); say(); } };
    } catch (e) { say(); }
  });
}
async function speakLine(res) {
  const v = voiceSync();
  if (v.muted) return;
  v.status = 'speaking'; v.speaking = true; render();
  try {
    if (res.audio_base64) await playAudio(res.audio_base64, res.audio_mime);
    else await speakWithBrowser(res.say);
  } catch (e) {
    v.notice = 'Your browser held the sound back until the page is touched. Tap anywhere (or Play the line) and the AI speaks.';
    armAudioRetry();
  }
  v.speaking = false;
}
/* Browsers may refuse audio that arrives after an async round trip. The opening line is played
   inside the click that starts the call, so this only matters for later turns: any tap releases it. */
function armAudioRetry() {
  const v = voiceSync();
  if (v.retryArmed) return;
  v.retryArmed = true;
  const retry = e => {
    v.retryArmed = false;
    const pending = v.blockedAudio;
    if (!pending) return;
    if (e && e.target && e.target.id === 'repeat-btn') return;   // that button plays it itself
    v.blockedAudio = null; v.notice = null;
    playAudio(pending.b64, pending.mime)
      .then(() => { v.status = v.done ? 'complete' : 'ready'; render(); })
      .catch(() => { v.notice = 'Still blocked. Press Play the line.'; render(); });
  };
  try { document.addEventListener('click', retry, { once: true }); } catch (e) {}
}
function stopSpeaking() {
  const v = voiceSync();
  try { if (v.audioEl) { v.audioEl.pause(); v.audioEl = null; } } catch (e) {}
  try { if (window.speechSynthesis) window.speechSynthesis.cancel(); } catch (e) {}
  try { if (v.stopSpeakHook) v.stopSpeakHook(); } catch (e) {}
  v.stopSpeakHook = null;
  v.speaking = false;
}
function stopListening() {
  const v = voiceSync();
  try { if (v.rec) v.rec.stop(); } catch (e) {}
  try { if (v.stopListening) v.stopListening(); } catch (e) {}
  v.listening = false;
}

/* ---------------- listening ---------------- */
function pickEngine() {
  const pref = (state.voice.cfg && state.voice.cfg.stt_preference) || 'auto';
  const hasBrowser = !!(window.SpeechRecognition || window.webkitSpeechRecognition);
  const hasRecorder = !!(navigator.mediaDevices && navigator.mediaDevices.getUserMedia && window.MediaRecorder);
  if (pref === 'browser') return hasBrowser ? 'browser' : (hasRecorder ? 'openai' : null);
  if (pref === 'openai') return hasRecorder ? 'openai' : (hasBrowser ? 'browser' : null);
  return hasBrowser ? 'browser' : (hasRecorder ? 'openai' : null);
}
function blobToBase64(blob) {
  return new Promise((resolve, reject) => {
    try {
      const fr = new FileReader();
      fr.onload = () => resolve(String(fr.result).split(',')[1] || '');
      fr.onerror = () => reject(new Error('Could not read the recording.'));
      fr.readAsDataURL(blob);
    } catch (e) { reject(e); }
  });
}
function listenBrowser() {
  return new Promise((resolve, reject) => {
    const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
    let rec;
    try { rec = new SR(); } catch (e) { return reject(e); }
    const v = voiceSync();
    v.rec = rec;
    rec.lang = (v.cfg && v.cfg.locale) || 'en-PH';
    rec.interimResults = true;
    rec.continuous = true;
    rec.maxAlternatives = 1;
    let finalText = '', silenceTimer = null, hardTimer = null, settled = false;
    const clear = () => { clearTimeout(silenceTimer); clearTimeout(hardTimer); };
    const done = txt => { if (settled) return; settled = true; clear(); v.listening = false; try { rec.stop(); } catch (e) {} resolve(String(txt || '').trim()); };
    const arm = ms => { clearTimeout(silenceTimer); silenceTimer = setTimeout(() => done(finalText), ms); };
    rec.onresult = e => {
      let interim = '';
      for (let i = e.resultIndex; i < e.results.length; i++) {
        const r = e.results[i];
        if (r.isFinal) finalText += r[0].transcript + ' ';
        else interim += r[0].transcript;
      }
      v.interim = (finalText + ' ' + interim).replace(/\s+/g, ' ').trim();
      updateLiveLine();
      arm(TIMING.silenceMs);
    };
    rec.onerror = ev => {
      const code = ev && ev.error;
      if (code === 'not-allowed' || code === 'service-not-allowed') {
        v.micBlocked = true; v.listening = false; clear();
        settled = true; return reject(new Error('mic-blocked'));
      }
      if (code === 'no-speech' && !finalText) { done(''); return; }
      done(finalText);
    };
    rec.onend = () => { if (!settled) done(finalText); };
    try { rec.start(); } catch (e) { return reject(e); }
    v.listening = true;
    arm(TIMING.noSpeechMs);
    hardTimer = setTimeout(() => done(finalText), TIMING.maxListenMs);
  });
}
function listenOpenAI() {
  return new Promise((resolve, reject) => {
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia || !window.MediaRecorder) {
      return reject(new Error('mic-blocked'));
    }
    navigator.mediaDevices.getUserMedia({ audio: true }).then(stream => {
      const v = voiceSync();
      const chunks = [];
      let rec, ctx = null, raf = null, stopped = false, heard = false;
      const startedAt = Date.now();
      let lastLoud = Date.now();
      const finish = async () => {
        if (stopped) return; stopped = true;
        try { if (raf && window.cancelAnimationFrame) window.cancelAnimationFrame(raf); } catch (e) {}
        try { if (ctx) ctx.close(); } catch (e) {}
        try { rec.stop(); } catch (e) {}
        try { stream.getTracks().forEach(t => t.stop()); } catch (e) {}
        const blob = new Blob(chunks, { type: (rec && rec.mimeType) || 'audio/webm' });
        v.listening = false;
        if (!blob.size) return resolve('');
        v.status = 'thinking'; render();
        try {
          const b64 = await blobToBase64(blob);
          const j = await api.post('/api/voice/transcribe', { audio_base64: b64, mime: blob.type || 'audio/webm' });
          if (!j.text) throw new Error('The transcription came back empty. Try again, or type instead.');
          resolve(String(j.text).trim());
        } catch (e) { reject(e); }
      };
      try {
        rec = new MediaRecorder(stream);
        rec.ondataavailable = e => { if (e.data && e.data.size) chunks.push(e.data); };
        rec.onstop = () => {};
        rec.start();
        v.rec = rec;
        v.stopListening = finish;
        const AC = window.AudioContext || window.webkitAudioContext;
        if (AC) {
          ctx = new AC();
          const analyser = ctx.createAnalyser();
          analyser.fftSize = 1024;
          ctx.createMediaStreamSource(stream).connect(analyser);
          const buf = new Uint8Array(analyser.fftSize);
          const tick = () => {
            if (stopped) return;
            try { analyser.getByteTimeDomainData(buf); } catch (e) {}
            let peak = 0;
            for (let i = 0; i < buf.length; i++) { const d = Math.abs(buf[i] - 128) / 128; if (d > peak) peak = d; }
            if (peak > TIMING.levelThreshold) { heard = true; lastLoud = Date.now(); }
            if (heard && Date.now() - lastLoud > TIMING.silenceMs) return finish();
            if (!heard && Date.now() - startedAt > TIMING.noSpeechMs) return finish();
            if (Date.now() - startedAt > TIMING.maxListenMs) return finish();
            raf = window.requestAnimationFrame ? window.requestAnimationFrame(tick) : setTimeout(tick, 120);
          };
          tick();
        } else {
          setTimeout(finish, TIMING.maxListenMs);
        }
      } catch (e) { try { stream.getTracks().forEach(t => t.stop()); } catch (e2) {} reject(e); }
    }).catch(e => {
      voiceSync().micBlocked = true;
      reject(new Error(e && e.name === 'NotAllowedError' ? 'mic-blocked' : 'mic-blocked'));
    });
  });
}
async function listenForAnswer() {
  const v = voiceSync();
  const engine = pickEngine();
  v.engine = engine;
  if (!engine) {
    v.micBlocked = true;
    v.typed = true;
    v.notice = 'No microphone is available in this browser, so typing is on. Type your answers below, or open the site in a browser with a microphone for the voice call.';
    v.status = 'ready'; render();
    return;
  }
  v.status = 'listening'; v.interim = ''; v.notice = null; v.error = null;
  render();
  let text = '';
  try {
    text = engine === 'browser' ? await listenBrowser() : await listenOpenAI();
  } catch (e) {
    v.listening = false;
    if (e && e.message === 'mic-blocked') {
      v.micBlocked = true; v.status = 'ready';
      v.notice = 'The microphone is blocked here (browsers block it inside preview iframes). Open the site in its own tab for the voice call, or tap "Type instead" and type your answers.';
      v.typed = true;
      render();
      return;
    }
    v.status = 'ready'; v.error = e.message || 'Microphone error.'; render();
    return;
  }
  v.interim = '';
  const heard = String(text || '').trim();
  if (!heard) {
    v.status = 'ready';
    v.notice = 'I did not catch that. Tap the microphone to try again, or type instead.';
    render();
    return;
  }
  v.lastHeard = heard;
  await voiceTurn(heard);
}

/* ---------------- one turn of the call ---------------- */
function answerIdFor() {
  const v = voiceSync();
  if (v.currentQuestionId) return v.currentQuestionId;      // the question the AI just asked
  const next = v.plan.find(q => !v.asked.includes(q.id));  // before the first turn
  return next ? next.id : null;
}
/* A probe answer is added to the original answer rather than replacing it, so the transcript
   keeps everything the client said about that question and Function A sees both parts. */
function recordAnswer(id, text, replace) {
  if (!id) return;
  const prev = state.answers.find(a => a.id === id);
  if (!prev) { state.answers.push({ id, text: text }); return; }
  if (replace) prev.text = text;
  else prev.text = (String(prev.text || '').trim() + ' ' + String(text || '').trim()).trim();
}
function buildTurnBody(lastAnswer) {
  const v = voiceSync();
  return {
    call_id: v.callId, call_ticket: v.callTicket,
    transcript: v.transcript.slice(-20).map(t => ({ role: t.role, text: t.text })),
    answers: state.answers, asked: v.asked, probes: v.probes, skipped: v.skipped,
    voice_captures: v.captures, last_answer: lastAnswer || null,
    with_audio: !v.muted, client_name: (state.user && state.user.name) || ''
  };
}
/* Everything a turn changes about the call, applied synchronously, so a prefetched opening line can
   be played inside the click that starts the call (browsers only allow sound from that gesture). */
function applyTurn(res) {
  const v = voiceSync();
  v.callTicket = res.call_ticket; v.turns = res.turn; v.capture = res.capture;
  v.warnings = res.warnings || [];
  v.provider = res.provider; v.mode = res.mode;
  if (Array.isArray(res.voice_captures)) v.captures = res.voice_captures;
  if (res.ask && res.ask.id) {
    if (res.ask.kind === 'probe' || res.ask.kind === 'callback') v.probes[res.ask.id] = (v.probes[res.ask.id] || 0) + 1;
    if (!v.asked.includes(res.ask.id)) v.asked.push(res.ask.id);
    v.currentQuestionId = res.ask.id;
  } else {
    v.currentQuestionId = null;
  }
  v.done = !!res.done;
  v.lastLine = res.say;
  if (v.done) v.endedAt = new Date().toISOString();
  v.transcript.push({ role: 'ai', text: res.say, questionId: res.ask && res.ask.id ? res.ask.id : null });
  render();
}
async function afterTurn(res) {
  const v = voiceSync();
  await speakLine(res);
  if (v.done) { v.status = 'complete'; render(); return; }
  if (v.listening) return;   // the user already tapped the microphone
  if (v.handsFree && !v.typed && !v.micBlocked) await listenForAnswer();
  else { v.status = 'ready'; render(); }
}
async function voiceTurn(userText) {
  const v = voiceSync();
  if (userText != null) {
    const id = answerIdFor();
    recordAnswer(id, userText, false);
    v.transcript.push({ role: 'user', text: userText, questionId: id });
  }
  v.status = 'thinking'; v.interim = ''; v.error = null; v.notice = null;
  render();
  let res;
  try {
    res = await api.post('/api/voice/turn', buildTurnBody(userText || null));
  } catch (e) {
    v.status = 'error'; v.error = e.message; render();
    return;
  }
  applyTurn(res);
  await afterTurn(res);
}
/* The opening line is fetched while the client is still reading the call screen, so pressing start
   speaks immediately instead of waiting for a round trip. */
async function prefetchOpening() {
  const v = voiceSync();
  if (v.startedAt || v.opening || v.prefetching || v.prefetchTried) return;
  v.prefetching = true; v.prefetchTried = true;
  try {
    await ensureSessionSilent();
    v.prefetchPromise = api.post('/api/voice/turn', buildTurnBody(null));
    v.opening = await v.prefetchPromise;
  } catch (e) {
    v.sessionError = e.message;   // the click handler retries and shows the error
  } finally {
    v.prefetching = false; v.prefetchPromise = null; render();
  }
}
async function startCall() {
  const v = voiceSync();
  v.error = null;
  if (!v.startedAt) v.startedAt = new Date().toISOString();
  const run = res => { applyTurn(res); afterTurn(res); };
  // Fast path: the opening turn is already in hand, so the AI starts speaking inside this click.
  if (v.opening) { const res = v.opening; v.opening = null; run(res); return; }
  if (v.prefetchPromise) {
    const res = await v.prefetchPromise.catch(() => null);
    if (res) { v.startedAt = v.startedAt || new Date().toISOString(); run(res); return; }
  }
  try { await ensureSession(); } catch (e) { return; }
  render();
  await voiceTurn(null);
}
function repeatLine() {
  const v = voiceSync();
  if (!v.lastLine) return;
  v.status = 'speaking'; render();
  api.post('/api/voice/speak', { text: v.lastLine }).then(j => {
    if (j.audio_base64) return playAudio(j.audio_base64, j.audio_mime).then(() => false).catch(() => true);
    return speakWithBrowser(v.lastLine).then(() => true);
  }).then(() => { v.status = v.done ? 'complete' : 'ready'; render(); })
    .catch(() => { speakWithBrowser(v.lastLine).then(() => { v.status = v.done ? 'complete' : 'ready'; render(); }); });
}
function skipQuestion() {
  const v = voiceSync();
  stopSpeaking(); stopListening();
  const id = v.currentQuestionId;
  if (id) {
    if (!v.asked.includes(id)) v.asked.push(id);
    if (!v.skipped.includes(id)) v.skipped.push(id);
    recordAnswer(id, '', true);
    v.transcript.push({ role: 'user', text: '(skipped)', questionId: id });
  }
  voiceTurn(null);
}
function finishCall() {
  stopSpeaking(); stopListening();
  voiceSync().endedAt = new Date().toISOString();
  startExtraction();
}

/* ---------------- rendering ---------------- */
function render() {
  const app = $('#app');
  if (!state.token) { app.innerHTML = loginView(); return; }
  let h = topbar() + '<main class="main">' + steps();
  switch (state.stage) {
    case 'consent': h += consentView(); break;
    case 'intake': h += callView(); break;
    case 'extracting': h += loaderView('extracting'); break;
    case 'review': h += reviewView(); break;
    case 'generating': h += loaderView('generating'); break;
    case 'blueprint': h += blueprintView(); break;
    case 'booking': h += bookingView(); break;
    case 'done': h += doneView(); break;
  }
  h += '</main>' + footer();
  app.innerHTML = h;
  if (state.stage === 'intake') afterCallRender();
}

function topbar() {
  return '<div class="topbar"><div class="brand">' +
    '<div class="logo"><svg width="18" height="18" viewBox="0 0 32 32"><path d="M10 21.5c1.2-4 3.4-6.8 6-7.5m6-3.5c-1.2 4-3.4 6.8-6 7.5" stroke="white" stroke-width="2.4" fill="none" stroke-linecap="round"/><path d="M22 6.5l.4 3.4-3.3.7M10 25.5l-.4-3.4 3.3-.7" stroke="white" stroke-width="2.4" fill="none" stroke-linecap="round" stroke-linejoin="round"/></svg></div>' +
    '<div>PipelineSync AI<small>Revenue operations blueprints</small></div></div>' +
    '<div class="topbar-right"><span>Signed in as <b>' + esc(state.user ? state.user.name : '') + '</b></span>' +
    '<button class="btn btn-ghost btn-sm" id="logout-btn">Log out</button></div></div>';
}
function steps() {
  const order = ['intake', 'review', 'blueprint', 'done', 'booking'];
  const idx = state.stage === 'consent' ? 0 : state.stage === 'extracting' ? 1 : order.indexOf(state.stage);
  const labels = [['1', 'Discovery call'], ['2', 'Review and correct'], ['3', 'Blueprint'], ['4', 'PDF and lead'], ['5', 'Book a call']];
  let h = '<div class="steps">';
  labels.forEach((l, i) => {
    const cls = i < idx ? 'done' : i === idx ? 'active' : '';
    h += '<div class="step ' + cls + '"><span class="n">' + (i < idx ? '&#10003;' : l[0]) + '</span>' + l[1] + '</div>';
  });
  return h + '</div>';
}
function footer() {
  return '<div class="footer"><span>Prototype build v0.2</span><span>The discovery call runs on the real OpenAI voice layer (ChatGPT wording, OpenAI speech and transcription) when OPENAI_API_KEY is set; extraction, PDF, and CRM steps are still simulated locally, with Supabase for auth and data in production.</span><span>All keys live server-side, never in the browser.</span><a href="/dev/outbox" target="_blank" rel="noopener">HubSpot outbox (dev)</a></div>';
}

/* ---------------- login ---------------- */
function loginView() {
  return '<div class="login-wrap"><div class="login-hero">' +
    '<div class="brand" style="margin-bottom:34px"><div class="logo"><svg width="18" height="18" viewBox="0 0 32 32"><path d="M10 21.5c1.2-4 3.4-6.8 6-7.5m6-3.5c-1.2 4-3.4 6.8-6 7.5" stroke="white" stroke-width="2.4" fill="none" stroke-linecap="round"/><path d="M22 6.5l.4 3.4-3.3.7M10 25.5l-.4-3.4 3.3-.7" stroke="white" stroke-width="2.4" fill="none" stroke-linecap="round" stroke-linejoin="round"/></svg></div><div>PipelineSync AI</div></div>' +
    '<h1>Talk it through. Get your HubSpot revenue operations blueprint.</h1>' +
    '<p class="lede">A short voice call with our AI interviewer. You review and correct what we heard, then we build a PDF blueprint of the exact HubSpot setup your pipeline needs. A human reviews and sells the build.</p>' +
    '<div class="mini-steps">' +
    '<div class="mini-step"><span class="n">1</span><div><b>Talk through your business</b><span>Two minutes of voice, like a conversation, not a form.</span></div></div>' +
    '<div class="mini-step"><span class="n">2</span><div><b>We structure the answers</b><span>AI extracts the facts into a clean data contract. Nothing invented.</span></div></div>' +
    '<div class="mini-step"><span class="n">3</span><div><b>You review and correct</b><span>Every field is editable. Unstated items are flagged, not guessed.</span></div></div>' +
    '<div class="mini-step"><span class="n">4</span><div><b>Your blueprint, your lead</b><span>A PDF built server-side, grounded in our knowledge base, plus a booking link.</span></div></div>' +
    '</div></div>' +
    '<div class="login-side"><div class="login-card"><div class="card">' +
    '<h2>Log in to start</h2>' +
    '<p class="sub">Login is required. In production this is Supabase Auth; the prototype uses a local session.</p>' +
    '<div class="field"><label for="lg-email">Email</label><input type="email" id="lg-email" placeholder="you@yourbusiness.ph"></div>' +
    '<div class="field"><label for="lg-pass">Password</label><input type="password" id="lg-pass" placeholder="Any 4+ characters in the prototype"></div>' +
    '<button class="btn btn-primary" id="lg-btn" style="width:100%">Log in</button>' +
    '<button class="btn btn-ghost mt8" id="demo-btn" style="width:100%">Use the demo account</button>' +
    '<p class="login-note">By continuing you agree to the AI disclaimer and privacy notice shown before data collection begins.</p>' +
    '</div></div></div></div>';
}
function bindLogin() {
  const go = (email, pass) => {
    api.post('/api/auth/login', { email, password: pass }).then(j => {
      state.token = j.token; state.user = j.user; saveAuth();
      state.stage = 'consent';
      render();
    }).catch(e => toast(e.message, true));
  };
  $('#lg-btn').onclick = () => go($('#lg-email').value, $('#lg-pass').value);
  $('#demo-btn').onclick = () => go('allen@pipelinesync.ai', 'demo1234');
  ['#lg-email', '#lg-pass'].forEach(sel => $(sel).addEventListener('keydown', e => { if (e.key === 'Enter') go($('#lg-email').value, $('#lg-pass').value); }));
}

/* ---------------- consent ---------------- */
function consentView() {
  return '<div class="card consent-card">' +
    '<h2>Before we record anything</h2>' +
    '<p class="sub">The brief requires a disclaimer and privacy notice before data collection. Please read both.</p>' +
    '<div class="notice"><h4>AI disclaimer</h4><p>This product uses AI. Your spoken and written answers are processed by AI models: OpenAI for the voice call (it words each question, speaks it, and transcribes your answers), and Claude for extraction and drafting in production. AI output can contain errors. A human reviews every blueprint before it is used in a build. Nothing in your blueprint is legal, financial, or professional advice.</p></div>' +
    '<div class="notice"><h4>Privacy notice</h4><p>Your answers are stored in our database (Supabase) so we can build your blueprint, and a summary is sent to our CRM (HubSpot) so the right person can follow up. We do not sell your data. Voice audio is transcribed and not retained beyond the transcript. You can request deletion at any time by emailing privacy@pipelinesync.ai.</p></div>' +
    '<label class="checkline"><input type="checkbox" id="consent-cb"> I understand how my data is used, and I agree to continue.</label>' +
    '<div class="btn-row"><button class="btn btn-primary btn-lg" id="consent-go" disabled>Agree and start the voice call</button></div>' +
    '<p class="small muted mt8" id="consent-note">The AI interviewer starts speaking as soon as you agree, then it listens while you answer out loud.</p>' +
    '</div>';
}

/* ---------------- the discovery call (voice first, transcript behind a link) ---------------- */
function fmtCaptured(v) {
  if (v === null || v === undefined || v === '') return '';
  if (Array.isArray(v)) {
    if (!v.length) return '';
    if (typeof v[0] === 'object') return v.length + (v.length === 1 ? ' item' : ' items');
    return v.join(', ');
  }
  return String(v);
}
function providerBadge() {
  const v = voiceSync();
  const openai = v.mode === 'openai';
  return '<span class="badge-mode ' + (openai ? 'openai' : 'simulated') + '">' +
    (openai ? 'ChatGPT voice' : 'Simulated voice') + '</span>';
}
function callView() {
  const v = voiceSync();
  const plan = v.plan || [];
  const total = plan.length || 12;
  const answered = state.answers.filter(a => String(a.text || '').trim()).length;
  const pct = Math.round((Math.min(answered, total) / total) * 100);
  const started = !!v.startedAt || v.transcript.length > 0;
  const statusText = VOICE_STATUS_TEXT[v.status] || VOICE_STATUS_TEXT.idle;
  const aiLine = v.lastLine || 'Alex, the PipelineSync AI interviewer, will call you. Twelve short questions about your business, all answered out loud. The AI speaks first, waits while you talk, then moves on.';
  const youLine = v.interim || v.lastHeard || '';

  let h = '<div class="intake-wrap"><div class="call">' +
    '<div class="call-head"><div class="who"><div class="avatar">AI</div><div><b>AI discovery call</b><span class="small muted" id="call-mode">' +
      (v.cfg ? (v.mode === 'openai' ? 'ChatGPT voice, ' + esc(v.cfg.models.tts) : 'simulated voice (no API key)') : 'connecting...') + '</span></div></div>' +
      '<div class="progress" id="call-progress">' + (started ? 'Question ' + Math.min(answered + 1, total) + ' of ' + total : 'Not started') + '</div></div>' +
    '<div class="progressbar"><div id="call-bar" style="width:' + pct + '%"></div></div>' +
    '<div class="call-body">' +
      '<div class="orb ' + esc(v.status) + (v.listening ? ' live' : '') + '" id="orb"><div class="rings"></div>' +
        '<svg width="34" height="34" viewBox="0 0 32 32"><path d="M10 21.5c1.2-4 3.4-6.8 6-7.5m6-3.5c-1.2 4-3.4 6.8-6 7.5" stroke="white" stroke-width="2.4" fill="none" stroke-linecap="round"/><path d="M22 6.5l.4 3.4-3.3.7M10 25.5l-.4-3.4 3.3-.7" stroke="white" stroke-width="2.4" fill="none" stroke-linecap="round" stroke-linejoin="round"/></svg></div>' +
      '<div class="call-status" id="call-status">' + esc(statusText) + '</div>' +
      '<div class="line ai" id="ai-line">' + esc(aiLine) + '</div>' +
      (youLine ? '<div class="line you" id="you-line">' + esc(youLine) + '</div>' : '<div class="line you empty" id="you-line">Your answer appears here as you speak.</div>') +
      (v.notice ? '<div class="call-note">' + esc(v.notice) + '</div>' : '') +
      (v.error ? '<div class="call-note err">' + esc(v.error) + ' <button class="btn btn-ghost btn-sm" id="retry-turn">Retry</button></div>' : '') +
    '</div>' +
    '<div class="call-controls" id="call-controls">' + callControls(started, total) + '</div>' +
    '</div>' + callSidebar() + '</div>';
  return h;
}
function callControls(started, total) {
  const v = voiceSync();
  if (!started) {
    const ready = !!v.opening;
    return '<div class="call-row"><button class="btn btn-primary btn-lg" id="start-call">&#9654; Start the discovery call (voice)</button>' +
      '<button class="btn btn-ghost" id="type-btn-pre">Type my answers instead</button></div>' +
      '<p class="small mt8" style="color:' + (ready ? 'var(--green)' : 'var(--muted)') + '">' +
      (ready
        ? 'Ready. The AI speaks the first question out loud the instant you press start.'
        : (v.prefetching || v.sessionPromise ? 'Preparing the AI voice...' : 'The AI speaks every question out loud and listens for your answer. Your microphone is used only during the call; audio is transcribed and not stored.')) + '</p>';
  }
  let h = '<div class="call-row">';
  h += '<button class="btn ' + (v.listening ? 'btn-dark' : 'btn-primary') + '" id="mic-btn"' + (v.status === 'thinking' || v.done ? ' disabled' : '') + '>' +
    (v.listening ? '&#9632; Stop and send' : '&#127908; Tap to answer') + '</button>';
  if (v.speaking) h += '<button class="btn btn-ghost" id="stop-speak">Skip the speech</button>';
  h += '<button class="btn ' + (v.blockedAudio ? 'btn-primary' : 'btn-ghost') + '" id="repeat-btn">' + (v.blockedAudio ? '&#9654; Play the line' : 'Hear that again') + '</button>';
  h += '<button class="btn btn-ghost" id="type-btn">Type instead</button>';
  h += '<button class="btn btn-ghost" id="mute-btn">' + (v.muted ? 'Unmute the AI voice' : 'Mute the AI voice') + '</button>';
  if (v.currentQuestionId && !v.done) h += '<button class="btn btn-ghost" id="skip-btn">Skip this question</button>';
  h += '</div>';
  if (v.done) {
    h += '<div class="call-row"><button class="btn btn-primary btn-lg" id="structure-btn">Structure my answers</button>' +
      '<span class="small muted">' + total + ' questions covered. You can correct anything on the next screen.</span></div>';
  } else if (v.asked.length >= 4) {
    h += '<div class="call-row"><button class="btn btn-ghost" id="finish-btn">Finish the call and review what we have</button></div>';
  }
  if (v.typed) {
    h += '<div class="chat-input"><textarea id="intake-input" rows="1" placeholder="Type your answer..."></textarea>' +
      '<button class="icon-btn" id="mic-back-btn" title="Answer out loud again">&#127908;</button>' +
      '<button class="btn btn-primary" id="send-btn">Send</button></div>';
  }
  return h;
}
function callSidebar() {
  const v = voiceSync();
  const labels = (v.cfg && v.cfg.field_labels) || FIELD_LABELS;
  const status = (v.capture && v.capture.status) || {};
  const fields = (v.capture && v.capture.fields) || {};
  const missingReq = (v.capture && v.capture.missingRequired) || (v.startedAt ? REQUIRED : []);
  const heard = (v.capture && v.capture.heard) || {};
  const chips = Object.keys(FIELD_LABELS).map(k => {
    const st = status[k] || 'pending';
    const val = fmtCaptured(fields[k]);
    const assist = !val && heard[k] ? ' (heard: ' + fmtCaptured(heard[k].value) + ')' : '';
    return '<div class="side-chip ' + (st === 'captured' ? 'filled' : 'null') + '"><span>' + esc(labels[k] || FIELD_LABELS[k]) + '</span>' +
      '<span class="val">' + esc((val || 'not yet') + assist) + '</span></div>';
  }).join('');
  const modeCard = '<div class="side-card"><h3>This call</h3>' +
    '<div class="provider-card">' + providerBadge() + '<span class="small muted">' + (v.mode === 'openai' ? 'OpenAI, server-side' : 'built-in questions, browser voice') + '</span></div>' +
    '<p class="small muted mt8">' + esc(v.why || 'Checking which voice provider is available...') + '</p>' +
    (v.cfg ? '<p class="small muted">Speaking: ' + esc(v.cfg.models.tts) + ' voice ' + esc(v.cfg.tts_voice) + '<br>Listening: ' + (v.engine === 'openai' ? 'OpenAI transcription (' + esc(v.cfg.models.stt) + ')' : 'browser microphone') + '<br>Turns so far: ' + v.turns + '<br>Audio is transcribed, never stored.</p>' : '') +
    (v.warnings && v.warnings.length ? '<p class="small" style="color:var(--amber)">' + esc(v.warnings[v.warnings.length - 1]) + '</p>' : '') +
    '</div>';
  const reqCard = missingReq.length
    ? '<div class="side-card warn"><h3>Needed before the blueprint</h3><p class="small">Still unstated: <b>' + missingReq.map(k => esc(labels[k] || FIELD_LABELS[k])).join(', ') + '</b>. The AI will ask again on the call, and you can add them on the review screen. Nothing is ever invented.</p></div>'
    : '<div class="side-card ok"><h3>Required numbers captured</h3><p class="small">Deal size, monthly lead volume and close rate are all captured, so the blueprint can be grounded in your own figures.</p></div>';
  const personaOpts = Object.keys(PERSONAS).map(k => '<option value="' + k + '">' + PERSONAS[k].label + '</option>').join('');
  const personaCard = '<div class="side-card"><h3>QA shortcut</h3>' +
    '<label class="small muted" for="persona-sel">Load a demo business without a call (Section 9 checklist)</label>' +
    '<select id="persona-sel"><option value="">Choose a vertical...</option>' + personaOpts + '</select>' +
    '<button class="btn btn-ghost btn-sm" id="persona-go" style="width:100%;margin-top:8px">Load demo answers</button>' +
    '<p class="small muted mt8">Typed demo answers for the four verticals (solar, medical, home services, e-commerce). Use these to check the blueprint quality checks.</p></div>';
  const bubbles = v.transcript.map(t => '<div class="bubble ' + (t.role === 'ai' ? 'ai' : 'user') + '">' + esc(t.text) + '</div>').join('');
  const transcriptCard = '<div class="side-card"><h3>Transcript</h3>' +
    '<p class="small muted">The call is spoken. This is the written record the AI will structure.</p>' +
    '<details class="transcript" id="transcript-wrap"' + (state.showTranscript ? ' open' : '') + '><summary id="transcript-toggle">Show transcript (' + v.transcript.length + ' lines)</summary>' +
    '<div class="chat-body" id="chat-body">' + (bubbles || '<p class="small muted">Nothing yet.</p>') + '</div></details></div>';
  return '<div>' + modeCard + '<div class="side-card"><h3>What we have captured</h3><div class="chip-col">' + chips + '</div></div>' + reqCard + transcriptCard + personaCard + '</div>';
}
function updateLiveLine() {
  const v = voiceSync();
  const el = $('#you-line');
  if (!el) return;
  const txt = v.interim || v.lastHeard || '';
  el.textContent = txt || 'Your answer appears here as you speak.';
  el.className = 'line you' + (txt ? '' : ' empty');
}
function bindCall() {
  const v = voiceSync();
  const start = $('#start-call');
  if (start) start.onclick = () => startCall();
  const preType = $('#type-btn-pre');
  if (preType) preType.onclick = () => { v.typed = true; v.startedAt = v.startedAt || new Date().toISOString(); render(); };
  const mic = $('#mic-btn');
  if (mic) mic.onclick = () => {
    if (v.listening) { stopListening(); return; }
    if (v.status === 'speaking') stopSpeaking();
    listNow();
  };
  const micBack = $('#mic-back-btn');
  if (micBack) micBack.onclick = () => { stopListening(); v.typed = false; render(); listNow(); };
  const stopSpeak = $('#stop-speak');
  if (stopSpeak) stopSpeak.onclick = () => { stopSpeaking(); v.status = v.done ? 'complete' : 'ready'; render(); };
  const rep = $('#repeat-btn');
  if (rep) rep.onclick = () => repeatLine();
  const typ = $('#type-btn');
  if (typ) typ.onclick = () => {
    stopListening();
    v.typed = true; v.status = 'ready'; render();
    const i = $('#intake-input'); if (i) i.focus();
  };
  const mute = $('#mute-btn');
  if (mute) mute.onclick = () => { v.muted = !v.muted; if (v.muted) stopSpeaking(); render(); };
  const skip = $('#skip-btn');
  if (skip) skip.onclick = () => skipQuestion();
  const fin = $('#finish-btn');
  if (fin) fin.onclick = () => finishCall();
  const st = $('#structure-btn');
  if (st) st.onclick = () => finishCall();
  const retry = $('#retry-turn');
  if (retry) retry.onclick = () => voiceTurn(null);
  const send = () => {
    const inp = $('#intake-input');
    const t = (inp ? inp.value : '').trim();
    if (!t) return;
    if (inp) inp.value = '';
    voiceTurn(t);
  };
  const sb = $('#send-btn');
  if (sb) sb.onclick = send;
  const inp = $('#intake-input');
  if (inp) {
    inp.focus();
    inp.addEventListener('keydown', e => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(); } });
    inp.addEventListener('input', () => { inp.style.height = 'auto'; inp.style.height = Math.min(inp.scrollHeight, 120) + 'px'; });
  }
  const pg = $('#persona-go');
  if (pg) pg.onclick = async () => {
    const sel = $('#persona-sel');
    const key = sel ? sel.value : '';
    if (!key) { toast('Pick a demo business first.', true); return; }
    try { await ensureSession(); } catch (e) { return; }
    const p = PERSONAS[key];
    const plan = voiceSync().plan;
    state.answers = plan.map(q => ({ id: q.id, text: p.answers[q.id] || '' }));
    const vs = voiceSync();
    vs.asked = plan.map(q => q.id);
    vs.done = true;
    vs.startedAt = vs.startedAt || new Date().toISOString();
    vs.endedAt = new Date().toISOString();
    vs.status = 'complete';
    vs.transcript = [];
    plan.forEach(q => {
      vs.transcript.push({ role: 'ai', text: q.ask, questionId: q.id });
      vs.transcript.push({ role: 'user', text: p.answers[q.id] || '(skipped)', questionId: q.id });
    });
    vs.lastLine = 'Demo answers loaded for ' + p.label + '. Nothing was asked out loud in this run.';
    state.showTranscript = true;
    toast('Loaded demo answers for ' + p.label + '. Review below.');
    render();
    refreshFieldStatus();
  };
  const tw = $('#transcript-wrap');
  if (tw) tw.addEventListener('toggle', () => { state.showTranscript = tw.open; });
}
function listNow() {
  const v = voiceSync();
  if (v.done) { toast('The call is finished. Structure your answers when you are ready.'); return; }
  if (v.status === 'thinking') { toast('Wait for the AI to finish thinking.'); return; }
  v.interim = '';
  updateLiveLine();
  listenForAnswer();
}
function afterCallRender() {
  const v = state.voice;
  if (!v) return;
  const body = $('#chat-body');
  if (body) body.scrollTop = body.scrollHeight;
  updateLiveLine();
  // Warm the session and the opening line while the client reads the screen, so the AI can speak
  // inside the click that starts the call.
  if (state.stage === 'intake' && !v.startedAt && !v.opening && !v.prefetching && !v.prefetchTried) prefetchOpening();
}

/* ---------------- capture status and hand-off to Function A ---------------- */
async function refreshFieldStatus() {
  const v = voiceSync();
  if (!state.answers.length) return;
  try {
    const j = await api.post('/api/extract', { answers: state.answers });
    const f = j.fields;
    const st = {};
    Object.keys(FIELD_LABELS).forEach(k => {
      const empty = f[k] === null || f[k] === '' || (Array.isArray(f[k]) && !f[k].length);
      st[k] = empty ? 'missing' : 'captured';
    });
    const prevHeard = (v.capture && v.capture.heard) || {};
    v.capture = {
      fields: f, status: st, heard: prevHeard,
      disagreements: Object.keys(prevHeard).filter(k => st[k] === 'missing'),
      missingRequired: REQUIRED.filter(k => st[k] === 'missing'),
      filledCount: Object.keys(st).filter(k => st[k] === 'captured').length,
      totalCount: Object.keys(FIELD_LABELS).length,
      answeredCount: state.answers.filter(a => String(a.text || '').trim()).length
    };
    render();
  } catch (e) { /* non-fatal: the review screen still shows the raw answers */ }
}
function voiceMeta() {
  const v = state.voice;
  if (!v || !v.startedAt) return null;
  const end = v.endedAt ? new Date(v.endedAt) : new Date();
  const dur = Math.max(0, Math.round((end - new Date(v.startedAt)) / 1000));
  return {
    provider: v.provider, mode: v.mode,
    models: v.cfg ? v.cfg.models : null, tts_voice: v.cfg ? v.cfg.tts_voice : null,
    language: (v.cfg && v.cfg.language) || null,
    call_id: v.callId, started_at: v.startedAt, ended_at: v.endedAt,
    duration_s: dur, turns: v.turns,
    questions_asked: v.asked, probes: Object.keys(v.probes).length,
    required_missing_at_call_end: (v.capture && v.capture.missingRequired) || [],
    transcript_turns: v.transcript.length,
    audio_retained: false
  };
}
async function startExtraction() {
  const v = state.voice;
  if (v && v.capture) {
    console.log('[voice] call finished: provider=' + v.provider + ' mode=' + v.mode + ' turns=' + v.turns +
      ' captured=' + v.capture.filledCount + '/' + v.capture.totalCount +
      ' missing_required=' + JSON.stringify(v.capture.missingRequired || []) + ' audio_retained=false');
  }
  state.stage = 'extracting';
  render();
  const stepsEl = document.querySelectorAll('.lstep');
  const steps = ['Calling Claude (Prompt B) on the transcript', 'Mapping answers to the data contract', 'Flagging unstated values as null'];
  for (let i = 0; i < steps.length; i++) {
    if (stepsEl[i]) stepsEl[i].className = 'lstep active';
    await sleep(750);
    if (stepsEl[i]) stepsEl[i].className = 'lstep done';
  }
  try {
    const j = await api.post('/api/extract', { answers: state.answers });
    state.fields = j.fields;
    state.stage = 'review';
    render();
  } catch (e) {
    state.stage = 'intake';
    render();
    toast(e.message, true);
  }
}

/* ---------------- loader ---------------- */
function loaderView(kind) {
  const steps = kind === 'extracting'
    ? ['Calling Claude (Prompt B) on the transcript', 'Mapping answers to the data contract', 'Flagging unstated values as null']
    : ['Loading knowledge base v1 (rules, tools, prices)', 'Selecting vertical recipe and compliance flags', 'Applying tier logic (Professional floor)', 'Choosing pipeline variant (one-call vs two-call)', 'Computing three cost-of-inaction estimates', 'Composing the blueprint (Prompt A) in UK English'];
  const title = kind === 'extracting' ? 'Structuring your answers' : 'Generating your blueprint';
  const sub = kind === 'extracting'
    ? 'Function A: transcript to structured fields. Unstated values come back as null, never invented.'
    : 'Function B: confirmed fields plus the knowledge base. The AI selects only from the knowledge base, and every reference is tagged.';
  let h = '<div class="card loader"><h2>' + title + '</h2><p class="sub">' + sub + '</p>';
  steps.forEach(s => { h += '<div class="lstep"><span class="ic"></span>' + s + '</div>'; });
  return h + '</div>';
}

/* ---------------- review ---------------- */
function reviewView() {
  const f = state.fields;
  const isNull = v => v === null || v === '' || (Array.isArray(v) && !v.length);
  // What the voice model says it heard on the call, used only to help fill gaps the parser missed.
  const heard = (state.voice && state.voice.capture && state.voice.capture.heard) || {};
  const heardNote = k => {
    const h = heard[k];
    if (!h) return '';
    return '<div class="heard">The AI heard <b>' + esc(h.value) + '</b> on the call' +
      (h.evidence ? ' ("' + esc(String(h.evidence).slice(0, 110)) + '")' : '') +
      '.<button class="btn btn-ghost btn-sm" data-heard="' + k + '">Use this</button></div>';
  };
  const groupHtml = (title, fields) => {
    let h = '<div class="review-group"><h3>' + title + '</h3><div class="review-grid">';
    fields.forEach(cfg => {
      const v = f[cfg.k];
      const nullish = isNull(v);
      const req = cfg.required ? ' <span class="req">REQUIRED</span>' : '';
      const badge = nullish ? '<span class="nullbadge">Not stated</span>' : '';
      const full = cfg.full ? ' review-full' : '';
      if (cfg.type === 'products') {
        const rows = (f.products || []).map((p, i) =>
          '<tr><td><input data-prod="' + i + '" data-pk="name" value="' + esc(p.name) + '"></td>' +
          '<td style="width:150px"><input data-prod="' + i + '" data-pk="price" value="' + esc(p.price) + '" placeholder="PHP"></td>' +
          '<td style="width:200px"><input data-prod="' + i + '" data-pk="prerequisite" value="' + esc(p.prerequisite) + '" placeholder="Needs..."></td>' +
          '<td><button class="del" data-del-prod="' + i + '" title="Remove row">&times;</button></td></tr>'
        ).join('');
        h += '<div class="field is-null' + (nullish ? ' is-null' : '') + ' review-full"><label>Products and services ' + badge + '</label>' +
          '<table class="tbl"><tr><th>Product / service</th><th>Price</th><th>Prerequisite</th><th></th></tr>' + rows + '</table>' +
          '<button class="btn btn-ghost btn-sm mt8" id="add-prod">Add product</button></div>';
      } else if (cfg.type === 'sources') {
        const rows = (f.lead_sources || []).map((s, i) =>
          '<tr><td><input data-src="' + i + '" data-sk="source" value="' + esc(s.source) + '"></td>' +
          '<td style="width:130px"><input data-src="' + i + '" data-sk="monthly_volume" value="' + esc(s.monthly_volume) + '" placeholder="per month"></td>' +
          '<td style="width:150px"><select data-src="' + i + '" data-sk="tracked">' +
          '<option value="unknown"' + (s.tracked == null ? ' selected' : '') + '>Unknown</option>' +
          '<option value="yes"' + (s.tracked === true ? ' selected' : '') + '>Tracked</option>' +
          '<option value="no"' + (s.tracked === false ? ' selected' : '') + '>Not tracked</option></select></td>' +
          '<td><button class="del" data-del-src="' + i + '" title="Remove row">&times;</button></td></tr>'
        ).join('');
        h += '<div class="field review-full"><label>Lead sources ' + badge + '</label>' +
          '<table class="tbl"><tr><th>Source</th><th>Monthly volume</th><th>Tracked?</th><th></th></tr>' + rows + '</table>' +
          '<button class="btn btn-ghost btn-sm mt8" id="add-src">Add source</button></div>';
      } else if (cfg.type === 'tags') {
        h += '<div class="field' + full + '"><label>Current tools ' + badge + '</label>' +
          '<input data-key="' + cfg.k + '" type="text" value="' + esc(Array.isArray(v) ? v.join(', ') : (v || '')) + '" placeholder="Comma separated">';
      } else if (cfg.type === 'select') {
        const opts = cfg.options.map(o => '<option value="' + o + '"' + (v === o ? ' selected' : '') + '>' + o + '</option>').join('');
        h += '<div class="field' + (nullish ? ' is-null' : '') + full + '"><label>' + cfg.label + req + badge + '</label>' +
          '<select data-key="' + cfg.k + '" data-type="select"' + (v == null ? ' data-nullsel="1"' : '') + '>' + (v == null ? '<option value="" selected>Not stated</option>' : '') + opts + '</select>' +
          (nullish ? heardNote(cfg.k) : '') + '</div>';
      } else if (cfg.type === 'textarea') {
        h += '<div class="field' + (nullish ? ' is-null' : '') + ' review-full"><label>' + cfg.label + req + badge + '</label>' +
          '<textarea data-key="' + cfg.k + '" data-type="text">' + esc(v) + '</textarea>' +
          (nullish ? heardNote(cfg.k) : '') + '</div>';
      } else {
        const ph = cfg.type === 'money' ? 'PHP amount' : cfg.type === 'number' ? 'Number' : 'Text';
        h += '<div class="field' + (nullish ? ' is-null' : '') + full + '"><label>' + cfg.label + req + badge + '</label>' +
          '<input data-key="' + cfg.k + '" data-type="' + (cfg.type === 'money' || cfg.type === 'number' ? 'number' : 'text') + '" value="' + esc(v) + '" placeholder="' + ph + '">' +
          (nullish ? heardNote(cfg.k) : '') + '</div>';
      }
    });
    return h + '</div></div>';
  };
  const groups = [
    ['Business', [
      { k: 'industry', label: 'Industry (vertical)', type: 'text' },
      { k: 'business_description', label: 'Business description', type: 'textarea' },
      { k: 'products', label: '', type: 'products', full: true },
      { k: 'typical_deal_size', label: 'Typical deal size', type: 'money', required: true },
      { k: 'sales_reps_on_calls', label: 'Sales reps on calls', type: 'number' },
      { k: 'fulfilment_headcount', label: 'Fulfilment headcount', type: 'number' },
      { k: 'marketing_ops_owner', label: 'Marketing and ops owner', type: 'text' },
      { k: 'close_type', label: 'Close type', type: 'select', options: ['one-call', 'two-call'] },
      { k: 'sales_process_notes', label: 'Sales process notes', type: 'textarea' }
    ]],
    ['Leads and tools', [
      { k: 'lead_sources', label: '', type: 'sources', full: true },
      { k: 'lead_capture_method', label: 'Lead capture method', type: 'text' },
      { k: 'current_crm', label: 'Current CRM', type: 'text' },
      { k: 'current_hubspot_tier', label: 'Current HubSpot tier', type: 'text' },
      { k: 'current_tools', label: '', type: 'tags', full: true }
    ]],
    ['Numbers', [
      { k: 'monthly_lead_volume', label: 'Monthly lead volume', type: 'number', required: true },
      { k: 'monthly_deal_volume', label: 'Monthly deal volume', type: 'number' },
      { k: 'close_rate', label: 'Close rate (%)', type: 'number', required: true },
      { k: 'sales_cycle_length', label: 'Sales cycle length (weeks)', type: 'number' },
      { k: 'monthly_marketing_spend', label: 'Monthly marketing spend', type: 'money' },
      { k: 'monthly_software_budget', label: 'Monthly software budget', type: 'money' },
      { k: 'fulfilment_method', label: 'Fulfilment method', type: 'text' }
    ]],
    ['Goals', [
      { k: 'biggest_headache', label: 'Biggest headache', type: 'textarea' },
      { k: 'six_month_goal', label: 'Six-month goal', type: 'textarea' }
    ]]
  ];
  const v = state.voice;
  const callLine = v && v.startedAt
    ? '<div class="call-summary">' + providerBadge() + ' <span class="small muted">' + (v.mode === 'openai' ? 'ChatGPT voice' : 'Simulated voice (no API key)') +
      ' · ' + v.turns + ' turns · ' + v.asked.length + ' of ' + ((v.plan || []).length || 12) + ' questions asked · ' +
      (v.capture ? (v.capture.filledCount + ' of ' + v.capture.totalCount + ' fields captured') : 'captured live') +
      ' · audio not retained</span></div>'
    : '';
  let h = '<div class="card"><h2>Review and correct your answers</h2>' + callLine +
    '<p class="sub">This is what the AI understood from the call. Anything marked <span class="nullbadge">Not stated</span> was not captured, so the blueprint cannot ground itself without it. Prices and tool names are preserved exactly, not corrected.</p>';
  groups.forEach(g => { h += groupHtml(g[0], g[1]); });
  h += '<div class="btn-row"><button class="btn btn-primary" id="confirm-fields">Confirm and generate blueprint</button>' +
    '<button class="btn btn-ghost" id="back-intake">Back to the call</button></div>' +
    '<p class="small muted mt8" id="confirm-hint"></p></div>';
  return h;
}
function collectFields() {
  const f = JSON.parse(JSON.stringify(state.fields));
  document.querySelectorAll('[data-key]').forEach(el => {
    const k = el.getAttribute('data-key');
    const t = el.getAttribute('data-type') || 'text';
    if (k === 'current_tools') {
      f[k] = el.value.split(',').map(s => s.trim()).filter(Boolean);
    } else if (t === 'number') {
      const v = (el.value || '').trim();
      f[k] = v === '' ? null : parseFloat(v);
    } else f[k] = el.value === '' ? null : el.value;
  });
  // products
  const prods = [];
  document.querySelectorAll('[data-prod]').forEach(el => {
    const i = el.getAttribute('data-prod'), pk = el.getAttribute('data-pk');
    if (!prods[i]) prods[i] = { name: '', price: null, prerequisite: null };
    const v = el.value.trim();
    if (pk === 'price') prods[i].price = v === '' ? null : parseFloat(String(v).replace(/[^0-9.]/g, ''));
    else prods[i][pk] = v;
  });
  f.products = prods.filter(p => p && p.name);
  // sources
  const srcs = [];
  document.querySelectorAll('[data-src]').forEach(el => {
    const i = el.getAttribute('data-src'), sk = el.getAttribute('data-sk');
    if (!srcs[i]) srcs[i] = { source: '', monthly_volume: null, tracked: null };
    const v = el.value.trim();
    if (sk === 'monthly_volume') srcs[i].monthly_volume = v === '' ? null : parseFloat(v);
    else if (sk === 'tracked') srcs[i].tracked = el.value === 'yes' ? true : el.value === 'no' ? false : null;
    else srcs[i][sk] = v;
  });
  f.lead_sources = srcs.filter(s => s && s.source);
  return f;
}
function bindReview() {
  const hint = $('#confirm-hint');
  const check = () => {
    const f = collectFields();
    const missing = REQUIRED.filter(k => f[k] == null || isNaN(f[k]) || f[k] <= 0);
    hint.textContent = missing.length ? 'Still needed before we can generate: ' + missing.map(k => FIELD_LABELS[k]).join(', ') + '.' : 'All required numbers are set. The blueprint will be grounded in these figures.';
    hint.style.color = missing.length ? 'var(--amber)' : 'var(--green)';
    $('#confirm-fields').disabled = missing.length > 0;
  };
  check();
  $('#confirm-fields').onclick = () => {
    const f = collectFields();
    if (f.close_type == null) f.close_type = 'two-call';
    startGeneration(f);
  };
  $('#back-intake').onclick = () => { state.stage = 'intake'; render(); };
  const addProd = $('#add-prod');
  if (addProd) addProd.onclick = () => {
    const f = collectFields();
    state.fields = f;
    state.fields.products.push({ name: '', price: null, prerequisite: null });
    render(); checkRefocus('confirm-fields');
  };
  const addSrc = $('#add-src');
  if (addSrc) addSrc.onclick = () => {
    const f = collectFields();
    state.fields = f;
    state.fields.lead_sources.push({ source: '', monthly_volume: null, tracked: null });
    render(); checkRefocus('confirm-fields');
  };
  document.querySelectorAll('[data-del-prod]').forEach(b => b.onclick = () => {
    const i = b.getAttribute('data-del-prod');
    const f = collectFields();
    f.products.splice(+i, 1);
    state.fields = f; render(); check();
  });
  document.querySelectorAll('[data-del-src]').forEach(b => b.onclick = () => {
    const i = b.getAttribute('data-del-src');
    const f = collectFields();
    f.lead_sources.splice(+i, 1);
    state.fields = f; render(); check();
  });
  document.querySelectorAll('[data-heard]').forEach(b => b.onclick = () => {
    const k = b.getAttribute('data-heard');
    const raw = (((state.voice || {}).capture || {}).heard || {})[k];
    const el = document.querySelector('[data-key="' + k + '"]');
    if (!raw || !el) return;
    const type = el.getAttribute('data-type') || 'text';
    if (type === 'number') { const n = looseNumber(raw.value); el.value = n == null ? '' : n; }
    else if (type === 'select') {
      const want = /one.?call/i.test(raw.value) ? 'one-call' : /two.?call|second call/i.test(raw.value) ? 'two-call' : '';
      if (want) el.value = want;
    } else el.value = String(raw.value);
    el.dispatchEvent(new Event('input'));
    toast('Filled from what the AI heard on the call. Please check it.');
  });
  document.querySelectorAll('input[data-key], textarea[data-key], select[data-key]').forEach(el => {
    el.addEventListener('input', () => {
      const f = collectFields();
      state.fields = f;
      check();
    });
  });
}
function checkRefocus(id) {
  const btn = document.getElementById(id);
  if (btn) { /* re-run validation via input event on any field */ }
  const hint = $('#confirm-hint');
  if (hint && btn) {
    // re-evaluate
    const f = collectFields();
    const missing = REQUIRED.filter(k => f[k] == null || isNaN(f[k]) || f[k] <= 0);
    hint.textContent = missing.length ? 'Still needed before we can generate: ' + missing.map(k => FIELD_LABELS[k]).join(', ') + '.' : 'All required numbers are set. The blueprint will be grounded in these figures.';
    hint.style.color = missing.length ? 'var(--amber)' : 'var(--green)';
    btn.disabled = missing.length > 0;
  }
}
async function startGeneration(fields) {
  state.fields = fields;
  state.stage = 'generating';
  render();
  const stepsEl = document.querySelectorAll('.lstep');
  await sleep(800);
  for (let i = 0; i < stepsEl.length; i++) {
    stepsEl[i].className = 'lstep active';
    await sleep(620);
    stepsEl[i].className = 'lstep done';
  }
  try {
    const j = await api.post('/api/generate', { fields });
    state.blueprint = j.blueprint;
    state.stage = 'blueprint';
    render();
  } catch (e) {
    state.stage = 'review';
    render();
    toast(e.message, true);
  }
}

/* ---------------- blueprint ---------------- */
function blueprintView() {
  const bp = state.blueprint;
  const stageCls = s => s === 'Closed Won' ? ' won' : s === 'Closed Lost' ? ' lost' : '';
  const stages = bp.pipeline.stages.map((s, i) =>
    '<span class="stage' + stageCls(s) + '">' + esc(s) + '</span>' + (i < bp.pipeline.stages.length - 1 ? '<span class="stage-arrow">&rarr;</span>' : '')
  ).join('');
  const stats = bp.summary.stats.map(s => '<div class="stat"><div class="v">' + esc(s.value) + '</div><div class="l">' + esc(s.label) + '</div></div>').join('');
  const tools = bp.tools.length
    ? '<table class="tbl"><tr><th>Tool</th><th>Recommendation</th><th>Why</th></tr>' +
      bp.tools.map(t => {
        const cls = t.action.toLowerCase().includes('keep') ? 'action-keep' : t.action.toLowerCase().includes('upgrade') ? 'action-upgrade' : t.action.toLowerCase().includes('replace') ? 'action-replace' : 'action-consolidate';
        return '<tr><td><b>' + esc(t.name) + '</b></td><td class="' + cls + '">' + esc(t.action) + '</td><td class="small">' + esc(t.reason) + '</td></tr>';
      }).join('') + '</table>'
    : '<p class="muted">No tools were stated. The stack is reviewed at the build call.</p>';
  const srcs = bp.leadSources.map(s =>
    '<li><b>' + esc(s.name) + '</b> (' + (s.monthlyVolume != null ? s.monthlyVolume : '?') + '/mo, ' + (s.tracked === false ? 'currently untracked' : s.tracked === true ? 'tracked' : 'tracking unclear') + '): ' + esc(s.mechanism) + '</li>'
  ).join('');
  const coa = bp.coa.items.map(c =>
    '<div class="coa-item"><div class="t">' + esc(c.title) + '</div><div class="v">' + fmtMoney(c.value) + ' <span class="small muted">(' + esc(c.period) + ')</span></div>' +
    '<div class="b">Basis: ' + esc(c.basis) + '</div></div>'
  ).join('');
  const compliance = bp.compliance.length
    ? bp.compliance.map(c => '<div class="compliance-flag"><span class="code">' + esc(c.code) + '</span><span>' + esc(c.note) + '</span></div>').join('')
    : '<p class="muted">No compliance flags in knowledge base v1 for this vertical.</p>';
  const kbChips = bp.kbReferences.map(r => '<span class="chip kb">' + esc(r) + '</span>').join('');
  const delivered = state.delivered;
  let h = '<div class="doc">' +
    '<div class="doc-head"><div class="kicker">PIPELINESYNC AI  |  ' + esc(bp.meta.verticalLabel).toUpperCase() + '</div>' +
    '<h2>Revenue Operations Blueprint</h2>' +
    '<div class="meta">' + esc(bp.meta.businessLine) + '  |  Prepared ' + esc(bp.meta.date) + '  |  ' + esc(bp.meta.generatedBy) + '</div></div>' +
    '<h3 class="sec"><span class="sn">1</span>Executive summary</h3>' +
    '<p>' + esc(bp.summary.text) + '</p><div class="stat-row">' + stats + '</div>' +
    '<h3 class="sec"><span class="sn">2</span>Recommended HubSpot stack</h3>' +
    '<ul><li><b>Core:</b> ' + esc(bp.stack.tier) + '</li>' +
    bp.stack.addOns.map(a => '<li><b>Add-on:</b> ' + esc(a) + '</li>').join('') +
    '<li>' + esc(bp.stack.pricingLine) + '</li></ul>' +
    '<p class="small muted">' + esc(bp.stack.pricingNote) + '</p>' +
    '<ul>' + bp.stack.rationale.map(r => '<li>' + esc(r) + '</li>').join('') + '</ul>' +
    '<h3 class="sec"><span class="sn">3</span>Pipeline architecture</h3>' +
    '<p>' + esc(bp.pipeline.label) + ' (' + esc(bp.pipeline.variant) + ' close). ' + esc(bp.pipeline.note) + '</p>' +
    '<div class="stage-flow">' + stages + '</div>' +
    '<ul>' + bp.pipeline.workflows.map(w => '<li>Workflow: ' + esc(w) + '</li>').join('') + '</ul>' +
    '<h3 class="sec"><span class="sn">4</span>Lead source architecture</h3>' +
    (srcs ? '<ul>' + srcs + '</ul>' : '<p class="muted">No lead sources were stated.</p>') +
    '<h3 class="sec"><span class="sn">5</span>Tool mapping (current to recommended)</h3>' + tools +
    '<h3 class="sec"><span class="sn">6</span>Build plan</h3>' +
    '<p><b>Confirmed defaults (included in the tier):</b></p><ul>' + bp.build.defaults.map(d => '<li>' + esc(d) + '</li>').join('') + '</ul>' +
    '<p><b>Custom items to create for you:</b></p><ul>' + bp.build.custom.map(d => '<li>' + esc(d) + '</li>').join('') + '</ul>' +
    '<h3 class="sec"><span class="sn">7</span>Cost of inaction (from your numbers)</h3>' + coa +
    '<div class="coa-total">Total estimated cost of inaction: <b>' + fmtMoney(bp.coa.totalMonthly) + ' per month</b>, ' + fmtMoney(bp.coa.totalSix) + ' over six months.</div>' +
    '<h3 class="sec"><span class="sn">8</span>Compliance</h3>' + compliance +
    '<h3 class="sec"><span class="sn">9</span>Next steps</h3><ol>' + bp.nextSteps.map(s => '<li>' + esc(s) + '</li>').join('') + '</ol>' +
    '<div class="doc-foot">Sourced exclusively from knowledge base v1 (no invented properties, tools, features, or prices):<div class="chip-row mt8">' + kbChips + '</div>' +
    '<p class="mt8">Generated by PipelineSync AI from your confirmed answers. Figures are planning estimates, not a quote. Prepared in UK English.</p></div>' +
    '</div>';

  h += '<div class="btn-row">' +
    (delivered
      ? '<button class="btn btn-dark" id="redownload-btn">&#11015; Download ' + esc(delivered.filename) + ' again</button>' +
        '<button class="btn btn-primary" id="book-btn">Book a call</button>' +
        '<button class="btn btn-ghost" id="new-biz">Run another business</button>'
      : '<button class="btn btn-primary" id="unlock-btn">Unlock the PDF</button>' +
        '<button class="btn btn-ghost" id="new-biz">Run another business</button>') +
    '</div>';

  if (delivered) {
    h += '<div class="success-card"><h3>&#10003; PDF delivered and lead captured</h3>' +
      '<p>The PDF was generated server-side (Function C) and the lead was pushed to HubSpot (Function D).</p>' +
      '<div class="kv"><span class="k">HubSpot contact ID</span><span class="v mono">' + esc(delivered.contact_id) + '</span></div>' +
      '<div class="kv"><span class="k">Delivered to</span><span class="v">' + esc(delivered.email) + '</span></div>' +
      '<div class="kv"><span class="k">File</span><span class="v">' + esc(delivered.filename) + '</span></div></div>';
  } else {
    h += '<div id="unlock-holder"></div>';
  }
  return h;
}
function bindBlueprint() {
  $('#new-biz').onclick = () => { resetJourney(); render(); };
  const bb = $('#book-btn');
  if (bb) bb.onclick = () => { state.stage = 'booking'; render(); };
  const rd = $('#redownload-btn');
  if (rd) rd.onclick = () => downloadPdf(state.delivered);
  const ub = $('#unlock-btn');
  if (ub) ub.onclick = () => {
    const holder = $('#unlock-holder');
    holder.innerHTML = '<div class="unlock-panel"><h3 style="font-size:16px;margin-bottom:4px">Unlock your blueprint PDF</h3>' +
      '<p class="small muted">Delivery is gated behind email, and your lead is created in HubSpot at the same moment.</p>' +
      '<div class="grid-2"><div class="field"><label for="un-email">Email for delivery</label><input type="email" id="un-email" value="' + esc(state.user.email) + '"></div>' +
      '<div class="field" style="display:flex;align-items:flex-end;padding-bottom:6px"><label class="checkline" style="margin:0"><input type="checkbox" id="un-consent"> I agree to receive the PDF and to be contacted about the build.</label></div></div>' +
      '<button class="btn btn-primary" id="un-go" disabled>Generate and send my PDF</button></div>';
    const cb = $('#un-consent'), go = $('#un-go');
    cb.onchange = () => { go.disabled = !cb.checked; };
    go.onclick = async () => {
      go.disabled = true; go.textContent = 'Generating PDF server-side...';
      try {
        const j = await api.post('/api/deliver', {
          email: $('#un-email').value,
          consent: cb.checked,
          fields: state.fields,
          blueprint: state.blueprint,
          voice_meta: voiceMeta()
        });
        state.delivered = {
          contact_id: j.contact_id, filename: j.filename,
          pdf_base64: j.pdf_base64, email: $('#un-email').value.trim().toLowerCase()
        };
        render();
        downloadPdf(state.delivered);
      } catch (e) {
        go.disabled = false; go.textContent = 'Generate and send my PDF';
        toast(e.message, true);
      }
    };
  };
}
function downloadPdf(d) {
  if (!d || !d.pdf_base64) return;
  try {
    const bin = atob(d.pdf_base64);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    const blob = new Blob([bytes], { type: 'application/pdf' });
    const u = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = u; a.download = d.filename;
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(u), 4000);
    toast('PDF downloaded. Lead ' + d.contact_id + ' pushed to HubSpot.');
  } catch (e) {
    toast('Could not auto-download in this browser. Use "Download PDF again".', true);
  }
}

/* ---------------- booking (HubSpot Meetings embed stand-in) ---------------- */
function bookingView() {
  const days = [];
  const now = new Date();
  let d = new Date(now);
  while (days.length < 7) {
    d = new Date(d.getTime() + 86400000);
    if (d.getDay() !== 0 && d.getDay() !== 6) days.push(new Date(d));
  }
  const dayStrs = days.map(x => x.toISOString().slice(0, 10));
  const slots = ['09:00', '10:00', '11:00', '13:00', '14:00', '15:00'];
  const b = state.booking || {};
  const dayBtns = days.map((x, i) =>
    '<div class="day' + (b.day === dayStrs[i] ? ' sel' : '') + '" data-day="' + dayStrs[i] + '"><div class="dow">' +
    x.toLocaleDateString('en-GB', { weekday: 'short' }) + '</div><div class="dnum">' + x.getDate() + '</div></div>'
  ).join('');
  const slotBtns = slots.map(s => '<div class="slot' + (b.day && b.slot === s ? ' sel' : '') + '" data-slot="' + s + '"' + (b.day ? '' : ' style="opacity:.45;pointer-events:none"') + '>' + s + '</div>').join('');
  let h = '<div class="booking"><div class="card"><h2>Book a call</h2>' +
    '<p class="sub">30 minutes to walk through your blueprint and confirm scope. In production this panel is the embedded HubSpot Meetings scheduler (the link Allen provides).</p>' +
    '<h3 style="font-size:13px;text-transform:uppercase;letter-spacing:.5px;color:var(--muted);margin-bottom:8px">Pick a day</h3><div class="day-strip">' + dayBtns + '</div>' +
    '<h3 style="font-size:13px;text-transform:uppercase;letter-spacing:.5px;color:var(--muted);margin-bottom:8px">Pick a time (your local time)</h3><div class="slot-grid">' + slotBtns + '</div>' +
    '<div class="btn-row">' +
    '<button class="btn btn-primary" id="book-go" ' + (b.day && b.slot ? '' : 'disabled') + '>Request this slot</button>' +
    '<button class="btn btn-ghost" id="back-blueprint">Back to blueprint</button></div>' +
    '<div class="embed-note">Prototype scheduler. Production: HubSpot Meetings embed with the real availability of the delivery team.</div>' +
    '</div>';
  if (state.booking && state.booking.confirmed) {
    h += '<div class="success-card"><h3>&#10003; Meeting requested</h3>' +
      '<div class="kv"><span class="k">When</span><span class="v">' + esc(state.booking.day) + ' at ' + esc(state.booking.slot) + ' (Asia/Manila)</span></div>' +
      '<div class="kv"><span class="k">Duration</span><span class="v">30 minutes, video call</span></div>' +
      '<div class="kv"><span class="k">With</span><span class="v">Your PipelineSync build lead (human review before any build)</span></div>' +
      '<p class="mt8">A calendar invite would land in your inbox. In production this booking is attached to your HubSpot contact.</p></div>' +
      '<div class="btn-row"><button class="btn btn-dark" id="finish-btn">Finish</button></div>';
  }
  return h + '</div>';
}
function bindBooking() {
  document.querySelectorAll('[data-day]').forEach(el => el.onclick = () => {
    state.booking = { day: el.getAttribute('data-day'), slot: null };
    render();
  });
  document.querySelectorAll('[data-slot]').forEach(el => el.onclick = () => {
    if (!state.booking) state.booking = { day: null, slot: null };
    state.booking.slot = el.getAttribute('data-slot');
    render();
  });
  const go = $('#book-go');
  if (go) go.onclick = () => {
    state.booking.confirmed = true;
    render();
  };
  const bb = $('#back-blueprint');
  if (bb) bb.onclick = () => { state.stage = 'blueprint'; render(); };
  const fin = $('#finish-btn');
  if (fin) fin.onclick = () => { state.stage = 'done'; render(); };
}

/* ---------------- done ---------------- */
function doneView() {
  const bp = state.blueprint;
  const d = state.delivered;
  const b = state.booking;
  let h = '<div class="card" style="max-width:680px;margin:30px auto;text-align:center">' +
    '<div class="logo" style="width:54px;height:54px;border-radius:14px;background:var(--orange);display:grid;place-items:center;margin:0 auto 14px"><svg width="28" height="28" viewBox="0 0 32 32"><path d="M10 21.5c1.2-4 3.4-6.8 6-7.5m6-3.5c-1.2 4-3.4 6.8-6 7.5" stroke="white" stroke-width="2.4" fill="none" stroke-linecap="round"/><path d="M22 6.5l.4 3.4-3.3.7M10 25.5l-.4-3.4 3.3-.7" stroke="white" stroke-width="2.4" fill="none" stroke-linecap="round" stroke-linejoin="round"/></svg></div>' +
    '<h2>Your blueprint is on its way</h2>' +
    '<p class="sub">Everything the brief asks for happened in this run:</p>' +
    '<div style="text-align:left;max-width:460px;margin:0 auto">' +
    '<div class="kv"><span class="k">Blueprint</span><span class="v">' + (bp ? esc(bp.meta.verticalLabel) + ' vertical, ' + esc(bp.stack.tier) : 'n/a') + '</span></div>' +
    '<div class="kv"><span class="k">PDF</span><span class="v">' + (d ? esc(d.filename) + ' (generated server-side)' : 'not unlocked yet') + '</span></div>' +
    '<div class="kv"><span class="k">HubSpot lead</span><span class="v mono">' + (d ? esc(d.contact_id) : 'not created') + '</span></div>' +
    '<div class="kv"><span class="k">Call booking</span><span class="v">' + (b && b.confirmed ? esc(b.day) + ' at ' + esc(b.slot) : 'not booked') + '</span></div>' +
    '</div>' +
    '<div class="btn-row" style="justify-content:center">' +
    '<button class="btn btn-primary" id="new-biz2">Run another business</button>' +
    '<a class="btn btn-ghost" href="/dev/outbox" target="_blank" rel="noopener">Inspect the HubSpot outbox (dev)</a>' +
    '</div>' +
    '<p class="small muted mt16">QA tip: run the four demo personas (solar, medical, home services, e-commerce) and check each blueprint against the Section 9 checklist: no invented items, correct tier floor, correct pipeline variant, all lead sources present, exactly three cost-of-inaction estimates, compliance flags where due, UK English, no em dashes.</p>' +
    '</div>';
  return h;
}
function bindDone() {
  const n = $('#new-biz2');
  if (n) n.onclick = () => { resetJourney(); render(); };
}

/* ---------------- global bindings + boot ---------------- */
function bindGlobal() {
  const lo = $('#logout-btn');
  if (lo) lo.onclick = async () => {
    try { await api.post('/api/auth/logout', {}); } catch (e) {}
    state.token = null; state.user = null; saveAuth(); resetJourney(); state.stage = 'login';
    render();
  };
}
function routeBindings() {
  bindGlobal();
  switch (state.stage) {
    case 'login': bindLogin(); break;
    case 'consent': {
      const cb = $('#consent-cb'), go = $('#consent-go');
      cb.onchange = () => { go.disabled = !cb.checked; };
      const note = $('#consent-note');
      if (note) note.textContent = voiceReady()
        ? 'Agree and the AI starts speaking straight away, then it listens while you answer out loud.'
        : 'Agree and the AI starts speaking, then it listens while you answer out loud. Preparing the voice now...';
      // The call plan and the opening line are fetched while the client reads the notice, so the AI
      // can speak inside the click that agrees to it.
      prefetchOpening();
      go.onclick = () => beginCall();
      break;
    }
    case 'intake': bindCall(); break;
    case 'review': bindReview(); break;
    case 'blueprint': bindBlueprint(); break;
    case 'booking': bindBooking(); break;
    case 'done': bindDone(); break;
  }
}
function boot() {
  render();
  routeBindings();
}
// re-bind after any render
const _render = render;
render = function () { _render(); routeBindings(); };
boot();
})();
