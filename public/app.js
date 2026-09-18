(function () {
'use strict';
/*
 * PipelineSync AI - prototype frontend (vanilla JS, no CDN, works offline in preview)
 * Production version of this layer is React on Netlify; the flow and data contract
 * are identical, only the rendering technology changes.
 * Security & a11y hardened version.
 */

const $ = s => document.querySelector(s);
const esc = s => String(s == null ? '' : s).replace(/[&<>\"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '\"': '&quot;', "'": '&#39;' }[c]));
const fmtMoney = v => v == null || v === '' ? '' : 'PHP ' + Number(v).toLocaleString('en-PH');
const sleep = ms => new Promise(r => setTimeout(r, ms));
const MAX_CHARS = 5000;
function debounce(fn, ms) {
  let t = null;
  return (...args) => {
    clearTimeout(t);
    t = setTimeout(() => fn(...args), ms);
  };
}
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
  stage: 'start',        // the entry gate: name + email, then straight to the voice call
  answers: [],           // [{id, text}] captured on the call (or by typing)
  fields: null,          // Section 7 contract
  blueprint: null,
  delivered: null,       // {contact_id, filename, pdf_url}
  booking: null,         // {day, slot}
  fieldStatus: {},       // live sidebar state
  voice: null,           // live call state (see newVoiceState in the voice engine)
  showTranscript: false, // transcript panel is collapsed; the call is spoken
  sideOpen: false,       // mobile: the call progress panel is a drawer
  fieldError: null       // live capture status problems, surfaced instead of failing silently
};
function saveAuth() {
  store.set('ps_token', state.token || '');
  store.set('ps_user', JSON.stringify(state.user || {}));
}
function resetJourney() {
  stopSpeaking(); stopListening();
  state.stage = 'consent'; state.answers = []; state.fields = null;
  state.blueprint = null; state.delivered = null; state.booking = null; state.fieldStatus = {};
  state.voice = null; state.showTranscript = false; state.sideOpen = false; state.fieldError = null;
}

/* ---------------- api ---------------- */
const api = {
  async post(p, body) {
    const r = await fetch(p, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(Object.assign({ token: state.token }, body)) });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) {
      if (r.status === 401) { state.token = null; state.user = null; saveAuth(); state.stage = 'start'; render(); }
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
  t.setAttribute('role', isErr ? 'alert' : 'status');
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

/* The continuous call has its own status wording: there is no button to press and no turn to wait
   for, so the screen must not imply one. */
const RT_STATUS_TEXT = {
  idle: 'Live call. Speak whenever you are ready.',
  connecting: 'Connecting the live voice call...',
  thinking: 'Saving what you just said...',
  speaking: 'Alex is speaking. Interrupt at any time.',
  listening: 'You are speaking. Take your time, there is nothing to press.',
  ready: 'Live call. Speak whenever you are ready, or interrupt Alex.',
  complete: 'That is the call. Review what we captured, then structure the answers.',
  error: 'The live call hit a problem. It carries on step by step below.'
};

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
    sessionPromise: null, sessionError: null, blockedAudio: null, retryArmed: false,
    rt: null, rtTried: false, rtFallback: false
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

/* ---------------- the continuous call (OpenAI Realtime over WebRTC) ----------------
 * One session carries the whole conversation. The microphone is opened once and stays open from the
 * first question to the last: the model hears where each answer ends (semantic turn detection) and
 * the lead can talk over it, so nothing is cut between questions and there is no button to press.
 *
 * The guardrail set still decides the content. After every answer the model calls record_answer;
 * that lands on /api/voice/realtime/tool, where lib/voice.js checks each claimed value against what
 * the lead actually said and hands back the next question the model is allowed to ask. Ungrounded
 * values are refused there, so nothing reaches the contract that was not said on the call.
 *
 * The API key never reaches the browser: the SDP offer is exchanged by our own server, which also
 * owns the session instructions, the tools and the voice.
 *
 * If WebRTC, the microphone or the realtime model is unavailable, the call falls back to the
 * step-by-step path below and continues from the same answers, so nobody is locked out.
 */
function newRealtimeState() {
  return {
    pc: null, dc: null, audioEl: null, mic: null, live: false, connecting: false, failed: null,
    startedAt: null, model: null, voice: null, vad: null, maxSessionMin: 15, watchdog: null,
    callTicket: null, opening: null, toolCalls: 0, accepted: 0, rejected: 0, endAttempts: 0,
    lastUserTurn: '', userLines: [], aiLines: [], handled: {}, aiPartial: '', pendingAttribution: null,
    responseActive: false, userSpeaking: false, closing: false, dropped: false, micMuted: false, micCalls: 0
  };
}
function rtSync() { const v = voiceSync(); return v.rt || (v.rt = newRealtimeState()); }
/* Continuous voice is only attempted when the server has it on and the browser can do WebRTC. */
function realtimePlanned() {
  const v = voiceSync();
  return !!(v.cfg && v.cfg.realtime && v.cfg.realtime.enabled && window.RTCPeerConnection &&
    navigator.mediaDevices && navigator.mediaDevices.getUserMedia);
}
function rtSend(obj) {
  const rt = voiceSync().rt;
  if (!rt || !rt.dc || rt.dc.readyState !== 'open') return false;
  try { rt.dc.send(JSON.stringify(obj)); return true; } catch (e) { return false; }
}
/* Ask the session to speak. `instructions` is the line the guardrail set picked on the server. */
function rtRespond(instructions) {
  const ev = { type: 'response.create' };
  if (instructions) ev.response = { instructions: String(instructions).slice(0, 1500) };
  return rtSend(ev);
}
function waitForIce(pc, ms) {
  return new Promise(resolve => {
    let done = false;
    const finish = () => { if (!done) { done = true; clearTimeout(timer); resolve(); } };
    const timer = setTimeout(finish, ms || 4000);
    try { if (pc.iceGatheringState === 'complete') return finish(); } catch (e) {}
    const onState = () => {
      let complete = false;
      try { complete = pc.iceGatheringState === 'complete'; } catch (e) {}
      if (!complete) return;
      try { pc.removeEventListener('icegatheringstatechange', onState); } catch (e) {}
      finish();
    };
    try { pc.addEventListener('icegatheringstatechange', onState); }
    catch (e) { try { pc.onicegatheringstatechange = onState; } catch (e2) {} }
  });
}
async function startRealtimeCall() {
  const v = voiceSync();
  const rt = rtSync();
  if (rt.live) return true;
  try { await ensureSession(); } catch (e) { rt.failed = e.message; return false; }
  if (!realtimePlanned()) { rt.failed = rt.failed || 'not-available'; return false; }
  v.engine = 'realtime';
  v.status = 'connecting'; v.error = null; render();
  rt.connecting = true;
  let mic = null;
  try {
    mic = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true } });
    rt.micCalls++;
  } catch (e) {
    rt.connecting = false; rt.failed = 'mic-blocked';
    return false;   // the step-by-step path shows the blocked-microphone notice and turns typing on
  }
  rt.mic = mic;
  let pc = null;
  try { pc = new RTCPeerConnection(); } catch (e) { cleanupRealtime(); rt.failed = 'webrtc'; return false; }
  rt.pc = pc;
  const audioEl = document.createElement('audio');
  audioEl.autoplay = true;
  try { audioEl.setAttribute('playsinline', ''); audioEl.setAttribute('aria-hidden', 'true'); } catch (e) {}
  audioEl.style.display = 'none';
  try { (document.body || document.documentElement).appendChild(audioEl); } catch (e) {}
  rt.audioEl = audioEl;
  v.audioEl = audioEl;
  pc.ontrack = e => {
    try {
      const stream = (e.streams && e.streams[0]) || (window.MediaStream ? new MediaStream([e.track]) : null);
      if (stream) audioEl.srcObject = stream;
      const p = audioEl.play();
      if (p && typeof p.catch === 'function') {
        p.catch(() => { v.notice = 'Your browser held the sound back. Tap anywhere and the live call continues.'; armAudioRetry(); });
      }
    } catch (err) {}
  };
  try {
    mic.getAudioTracks().forEach(track => {
      try { pc.addTrack(track, mic); } catch (e) { try { pc.addTrack(track); } catch (e2) {} }
    });
  } catch (e) {}
  let dc = null;
  try { dc = pc.createDataChannel('oai-events'); } catch (e) { cleanupRealtime(); rt.failed = 'datachannel'; return false; }
  rt.dc = dc;
  dc.onopen = () => {
    rt.live = true; rt.connecting = false; rt.dropped = false;
    v.status = 'speaking'; v.speaking = true;
    v.startedAt = v.startedAt || new Date().toISOString();
    rt.startedAt = v.startedAt;
    if (rt.opening && rt.opening.question_id) v.currentQuestionId = rt.opening.question_id;
    render();
    armSessionWatchdog();
    // The opening question was picked by the guardrail set on the server: ask the session to say it.
    rtRespond(rt.opening && rt.opening.instruction
      ? rt.opening.instruction + (rt.opening.ask_now ? ' Start with: "' + rt.opening.ask_now + '"' : '')
      : null);
  };
  dc.onmessage = e => handleRealtimeEvent(e && e.data);
  dc.onclose = () => { if (rt.live && !v.done && !rt.closing) dropRealtime('The live voice session closed.'); };
  dc.onerror = () => { if (!rt.live) { rt.connecting = false; cleanupRealtime(); rt.failed = rt.failed || 'datachannel'; } };
  let offer = null;
  try {
    offer = await pc.createOffer();
    await pc.setLocalDescription(offer);
    await waitForIce(pc, 4000);
  } catch (e) { cleanupRealtime(); rt.failed = 'offer'; return false; }
  const sdp = (pc.localDescription && pc.localDescription.sdp) || (offer && offer.sdp) || '';
  let res = null;
  try {
    res = await api.post('/api/voice/realtime/connect', {
      call_id: v.callId, sdp, client_name: (state.user && state.user.name) || '',
      answers: answersForUpload(), asked: v.asked, skipped: v.skipped, voice_captures: v.captures
    });
  } catch (e) { cleanupRealtime(); rt.failed = e.message; return false; }
  if (!res || !res.ok || !res.sdp) { cleanupRealtime(); rt.failed = (res && res.error) || 'connect-failed'; return false; }
  rt.callTicket = res.call_ticket || null;
  rt.opening = res.opening || null;
  rt.model = res.model || null; rt.voice = res.voice || null; rt.vad = res.turn_detection || null;
  rt.maxSessionMin = res.max_session_min || 15;
  v.provider = res.provider || 'openai-realtime';
  v.mode = 'realtime';
  if (res.warnings && res.warnings.length) v.warnings = (v.warnings || []).concat(res.warnings);
  try { await pc.setRemoteDescription({ type: 'answer', sdp: res.sdp }); }
  catch (e) { cleanupRealtime(); rt.failed = 'answer'; return false; }
  rt.connecting = false;
  return true;
}
/* A call has a ceiling: the session is closed by the client before the provider closes it. */
function armSessionWatchdog() {
  const v = voiceSync(); const rt = v.rt;
  if (!rt || rt.watchdog) return;
  const maxMs = Math.max(2, rt.maxSessionMin || 15) * 60 * 1000;
  rt.watchdog = setTimeout(() => {
    if (!rt.live || v.done) return;
    rt.closing = true;
    v.notice = 'We are at the time limit for one call, so let us wrap up. Everything captured is on the next screen.';
    rtRespond('We are out of time. Thank them, tell them the next step is to review and correct what we captured on screen, and that a human reviews the blueprint. Then call end_call.');
    setTimeout(() => { if (!v.done) finishCall(); }, 30000);
    render();
  }, maxMs);
}
function cleanupRealtime() {
  const v = voiceSync(); const rt = v.rt;
  if (!rt) return;
  if (rt.watchdog) { clearTimeout(rt.watchdog); rt.watchdog = null; }
  try { if (rt.dc) rt.dc.close(); } catch (e) {}
  try { if (rt.pc) rt.pc.close(); } catch (e) {}
  try { if (rt.mic) rt.mic.getTracks().forEach(t => t.stop()); } catch (e) {}
  try { if (rt.audioEl) { rt.audioEl.pause(); rt.audioEl.srcObject = null; if (rt.audioEl.parentNode) rt.audioEl.parentNode.removeChild(rt.audioEl); } } catch (e) {}
  rt.dc = null; rt.pc = null; rt.mic = null; rt.audioEl = null;
  rt.live = false; rt.userSpeaking = false; rt.responseActive = false;
  v.speaking = false; v.listening = false;
}
/* The live session died mid-call: keep everything captured and carry on step by step. */
function dropRealtime(reason) {
  const v = voiceSync(); const rt = v.rt;
  if (!rt || rt.dropped) return;
  rt.dropped = true; rt.live = false;
  const msg = String(reason || 'The live voice dropped.');
  cleanupRealtime();
  v.rtFallback = true;
  v.provider = 'openai'; v.mode = 'openai'; v.engine = null;
  v.notice = msg + ' The call carries on step by step from where you were, with everything you said kept.';
  v.warnings = (v.warnings || []).concat([msg + ' Fell back to the step-by-step call.']);
  v.status = 'ready';
  render();
  voiceTurn(null);
}
function handleRealtimeEvent(raw) {
  const v = voiceSync(); const rt = v.rt;
  if (!rt) return;
  let ev = null;
  try { ev = JSON.parse(raw); } catch (e) { return; }
  if (!ev || !ev.type) return;
  switch (ev.type) {
    case 'session.created':
    case 'session.updated': {
      const sess = ev.session || {};
      if (sess.model) rt.model = sess.model;
      break;
    }
    case 'input_audio_buffer.speech_started':
      rt.userSpeaking = true; v.status = 'listening'; v.speaking = false; v.interim = ''; rt.aiPartial = '';
      updateLiveLine(); render();
      break;
    case 'input_audio_buffer.speech_stopped':
      rt.userSpeaking = false; v.status = 'thinking'; render();
      break;
    case 'conversation.item.input_audio_transcription.delta':
      if (ev.transcript) { v.interim = String(ev.transcript); updateLiveLine(); }
      break;
    case 'conversation.item.input_audio_transcription.completed':
      onRealtimeUserTurn(ev.transcript || '');
      break;
    case 'response.created':
      rt.responseActive = true; rt.aiPartial = ''; v.status = 'speaking'; v.speaking = true; render();
      break;
    case 'response.output_audio_transcript.delta':
      if (ev.delta) { rt.aiPartial += String(ev.delta); v.lastLine = rt.aiPartial; updateAiLine(); }
      break;
    case 'response.output_audio_transcript.done':
      onRealtimeAiLine(ev.transcript || rt.aiPartial || '');
      break;
    case 'response.function_call_arguments.done':
      onRealtimeTool(ev.call_id || ev.item_id, ev.name, ev.arguments);
      break;
    case 'response.output_item.done':
      if (ev.item && ev.item.type === 'function_call') onRealtimeTool(ev.item.call_id || ev.item.id, ev.item.name, ev.item.arguments);
      break;
    case 'response.done': {
      rt.responseActive = false; v.speaking = false;
      const r = ev.response || {};
      const detail = (r.status_details && (r.status_details.reason || r.status_details.type)) || '';
      if (r.status === 'failed' || (r.status === 'incomplete' && detail && detail !== 'interrupted')) {
        v.warnings = (v.warnings || []).concat(['The live model cut a reply short (' + (detail || r.status) + ').']);
      }
      if (rt.closing && !v.done) { v.done = true; v.endedAt = new Date().toISOString(); v.status = 'complete'; }
      else if (!v.done) v.status = rt.userSpeaking ? 'listening' : 'ready';
      render();
      break;
    }
    case 'rate_limits.updated':
      break;
    case 'error': {
      const err = ev.error || {};
      const msg = String(err.message || err.code || 'The live voice session reported an error.');
      v.warnings = (v.warnings || []).concat([msg]);
      if (/session|expired|closed|not found|invalid_api_key|timeout/i.test(msg)) dropRealtime(msg);
      else render();
      break;
    }
    default: break;
  }
}
function onRealtimeUserTurn(text) {
  const v = voiceSync(); const rt = v.rt;
  const t = String(text || '').replace(/\s+/g, ' ').trim();
  rt.userSpeaking = false;
  if (!t) return;
  rt.lastUserTurn = t;
  rt.userLines.push(t);
  if (rt.userLines.length > 12) rt.userLines.shift();
  v.lastHeard = t; v.interim = '';
  /* Attribute the answer to the question Alex is on, so Function A still sees it even if the model
     forgets to call the tool. The server has the last word: a turn it judges off topic or empty is
     stripped back out below, so noise never reaches the contract. */
  const qid = v.currentQuestionId;
  rt.pendingAttribution = { qid: qid, text: t };
  if (qid) recordAnswer(qid, t, false);
  v.transcript.push({ role: 'user', text: t, questionId: qid });
  v.turns = (v.turns || 0) + 1;
  render();
}
function onRealtimeAiLine(text) {
  const v = voiceSync(); const rt = v.rt;
  const t = String(text || '').replace(/\s+/g, ' ').trim();
  if (!t) return;
  v.lastLine = t;
  rt.aiPartial = '';
  rt.aiLines.push(t);
  if (rt.aiLines.length > 8) rt.aiLines.shift();
  v.transcript.push({ role: 'ai', text: t, questionId: v.currentQuestionId });
  render();
}
/* The current turn's optimistic attribution is held back from the server, so the server decides
   whether it belongs in the answers at all. */
function answersForUpload() {
  const rt = voiceSync().rt;
  const attr = rt && rt.pendingAttribution;
  if (!attr || !attr.qid) return state.answers;
  return state.answers.map(a => {
    if (a.id !== attr.qid) return a;
    let t = String(a.text || '');
    if (t.indexOf(attr.text) >= 0) t = t.replace(attr.text, '').replace(/\s+/g, ' ').trim();
    return { id: a.id, text: t };
  });
}
function unrecordAttribution(attr) {
  if (!attr || !attr.qid) return;
  const a = state.answers.find(x => x.id === attr.qid);
  if (a && String(a.text || '').indexOf(attr.text) >= 0) {
    a.text = String(a.text).replace(attr.text, '').replace(/\s+/g, ' ').trim();
  }
  const lines = voiceSync().transcript;
  for (let i = lines.length - 1; i >= 0; i--) {
    if (lines[i].role === 'user' && lines[i].text === attr.text) { lines[i].ignored = true; break; }
  }
}
function applyRealtimeState(st) {
  const v = voiceSync();
  if (!st) return;
  if (Array.isArray(st.answers)) state.answers = st.answers.slice(0, 20).map(a => ({ id: String(a.id), text: String(a.text || '') }));
  if (Array.isArray(st.asked)) v.asked = st.asked.slice();
  if (st.probes && typeof st.probes === 'object') v.probes = Object.assign({}, st.probes);
  if (Array.isArray(st.skipped)) v.skipped = st.skipped.slice();
  if (Array.isArray(st.voice_captures)) v.captures = st.voice_captures.slice(-60);
  if (st.capture) v.capture = st.capture;
}
async function onRealtimeTool(callId, name, argsRaw) {
  const v = voiceSync(); const rt = v.rt;
  if (!name) return;
  const key = String(callId || '') + ':' + name;
  if (rt.handled[key]) return;   // the same call can arrive as arguments.done and as output_item.done
  rt.handled[key] = true;
  rt.toolCalls++;
  v.status = 'thinking'; render();
  let args = argsRaw;
  if (typeof args === 'string') { try { args = JSON.parse(args); } catch (e) { args = {}; } }
  if (!args || typeof args !== 'object') args = {};
  let out = null;
  try {
    const j = await api.post('/api/voice/realtime/tool', {
      call_id: v.callId, call_ticket: rt.callTicket, name, arguments: args,
      user_turn: rt.lastUserTurn, user_lines: rt.userLines.slice(-4), ai_lines: rt.aiLines.slice(-3),
      answers: answersForUpload(), asked: v.asked, probes: v.probes, skipped: v.skipped,
      voice_captures: v.captures, end_attempts: rt.endAttempts,
      client_name: (state.user && state.user.name) || ''
    });
    if (j && j.call_ticket) rt.callTicket = j.call_ticket;
    out = (j && j.output) || { instruction: 'Carry on with the next question on the intake set.' };
    if (out.saved === false && rt.pendingAttribution) unrecordAttribution(rt.pendingAttribution);
    rt.pendingAttribution = null;
    if (j && j.state) applyRealtimeState(j.state);
    if (Array.isArray(out.rejected)) rt.rejected += out.rejected.length;
    if (Array.isArray(out.accepted)) rt.accepted += out.accepted.length;
    if (out.end_attempts) rt.endAttempts = out.end_attempts;
    if (out.next && out.next.question_id) { v.currentQuestionId = out.next.question_id; v.pendingQuestionId = out.next.question_id; }
    if (out.next && out.next.kind === 'probe' && out.question_id) v.probes[out.question_id] = (v.probes[out.question_id] || 0) + 1;
    if (out.close === true) rt.closing = true;
    if (name === 'end_call' && out.close !== false) rt.closing = true;
    if (Array.isArray(j.warnings) && j.warnings.length) v.warnings = (v.warnings || []).concat(j.warnings);
  } catch (e) {
    rt.pendingAttribution = null;
    out = { error: e.message, instruction: 'Carry on with the next question on the intake set.' };
    v.notice = 'A save did not go through (' + e.message + '). The call carries on.';
  }
  v.interim = '';
  // Hand the result back to the session, then let it speak the next question the policy picked.
  rtSend({
    type: 'conversation.item.create',
    item: { type: 'function_call_output', call_id: String(callId || ''), output: JSON.stringify(out).slice(0, 3500) }
  });
  if (!rt.userSpeaking && !v.done) rtRespond(out.instruction || null);
  render();
  refreshFieldStatus();
}
/* Typing stays available on a live call: the text goes into the same session, so the model treats it
   exactly like a spoken answer and the guardrail set still records it. */
function sendRealtimeText(text) {
  const v = voiceSync(); const rt = v.rt;
  const t = String(text || '').trim();
  if (!t) return;
  const qid = v.currentQuestionId;
  rtSend({
    type: 'conversation.item.create',
    item: { type: 'message', role: 'user', content: [{ type: 'input_text', text: t.slice(0, 1200) }] }
  });
  rt.lastUserTurn = t;
  rt.userLines.push(t);
  recordAnswer(qid, t, false);
  v.transcript.push({ role: 'user', text: t, questionId: qid, typed: true });
  v.lastHeard = t;
  rtRespond('They typed that answer instead of speaking it. Treat it exactly as if they had said it: call record_answer for ' +
    (qid || 'the question you just asked') + ', then ask the next question.');
  render();
  refreshFieldStatus();
}
function realtimeRepeat() {
  const v = voiceSync();
  rtRespond('They did not catch that. Repeat your last question once, in the same words, a little more slowly, then wait for the answer.');
  v.status = 'speaking'; render();
}
function setRealtimeMicMuted(muted) {
  const rt = voiceSync().rt;
  if (!rt || !rt.mic) return;
  rt.micMuted = !!muted;
  try { rt.mic.getAudioTracks().forEach(t => { t.enabled = !rt.micMuted; }); } catch (e) {}
}
function setRealtimeSpeakerMuted(muted) {
  const v = voiceSync(); const rt = v.rt;
  v.muted = !!muted;
  try { if (rt && rt.audioEl) rt.audioEl.muted = !!muted; } catch (e) {}
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
  text = String(text == null ? '' : text).slice(0, MAX_CHARS);   // same ceiling the server enforces
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
    // A continuous call opens its own session and picks its own opening on the server, so prefetching
    // a step-by-step turn here would spend a turn (and a line of speech) for nothing.
    if (realtimePlanned()) { v.prefetching = false; render(); return; }
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
  /* Continuous voice first: one session for the whole call, nothing cut between questions. If the
     browser, the microphone or the model cannot do it, the same call carries on step by step below. */
  if (!v.rtTried) {
    v.rtTried = true;
    const live = await startRealtimeCall();
    if (live) return;
    const rt = v.rt;
    if (rt && rt.failed === 'mic-blocked') {
      v.micBlocked = true; v.typed = true; v.status = 'ready';
      v.notice = 'The microphone is blocked here (browsers block it inside preview iframes), so the live call cannot start. Open the site in its own tab for the continuous call, or type your answers below.';
      render();
      return;
    }
    if (rt && rt.failed) {
      v.notice = 'The continuous voice call could not start (' + String(rt.failed).slice(0, 140) + '). Running the same call step by step instead.';
      v.rtFallback = true;
    }
  }
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
  const v = voiceSync();
  const rt = v.rt;
  stopSpeaking(); stopListening();
  v.endedAt = new Date().toISOString();
  const wasLive = !!(rt && (rt.live || rt.startedAt));
  if (wasLive) { rt.closing = true; if (rt.audioEl) { try { rt.audioEl.pause(); } catch (e) {} } }
  cleanupRealtime();
  if (!wasLive) { startExtraction(); return; }
  /* The server recomputes the contract state from everything the call captured, so the review screen
     and Function A see exactly what the live call produced (and nothing that failed grounding). */
  api.post('/api/voice/realtime/end', {
    call_id: v.callId, answers: state.answers, asked: v.asked, probes: v.probes, skipped: v.skipped,
    voice_captures: v.captures,
    transcript: v.transcript.slice(-30).map(t => ({ role: t.role, text: t.text }))
  }).then(j => {
    if (j && j.capture) v.capture = j.capture;
    if (j && Array.isArray(j.voice_captures)) v.captures = j.voice_captures;
    if (j && j.provider) { v.provider = j.provider; v.mode = j.mode; }
    startExtraction();
  }).catch(() => startExtraction());
}

/* ---------------- rendering ---------------- */
function render() {
  const app = $('#app');
  if (!state.token) { app.innerHTML = startView(); return; }
  let h = topbar() + '<main class=\"main\" id=\"main-content\" tabindex=\"-1\">' + steps();
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
  if (state.stage === 'blueprint') animateNumbers();
}

/* PipelineSync brand mark as vector (same geometry as public/logo.svg). h = pixel height.
   Pass mono to render a single-colour variant (e.g. '#FFFFFF' on the call orb). */
function logoMark(h, mono) {
  const w = Math.round(h * 460 / 600);
  const navy = mono || '#0F2F52', steel = mono || '#3E6C8E', dot = mono || '#F57C1F';
  return '<svg width="' + w + '" height="' + h + '" viewBox="0 0 460 600" aria-hidden="true">' +
    '<g fill="none" stroke-width="58" stroke-linejoin="miter" stroke-linecap="butt">' +
    '<path stroke="' + navy + '" d="M402 32 V150 H150 A92.5 92.5 0 0 0 150 335 H200"/>' +
    '<path stroke="' + steel + '" d="M58 568 V450 H310 A92.5 92.5 0 0 0 310 265 H260"/>' +
    '</g>' +
    '<circle cx="200" cy="335" r="29" fill="' + navy + '"/>' +
    '<circle cx="260" cy="265" r="29" fill="' + steel + '"/>' +
    '<rect x="268" y="308" width="57" height="57" rx="14" fill="' + dot + '"/></svg>';
}
/* Initials for the header chip. The server returns them, but a session restored from an
   older token may not carry them, so derive them the same way here. */
function initialsFor(name) {
  const parts = String(name || '').trim().split(/\s+/).filter(Boolean);
  if (!parts.length) return '?';
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
}
function firstName() {
  return String((state.user && state.user.name) || '').trim().split(/\s+/)[0] || '';
}
/* The mark on a light plate. Its strokes are navy (#0F2F52) and steel (#3E6C8E), so on a dark
   surface - the entry-gate hero is a navy gradient - an un-plated mark measures 1.0:1 against it
   and disappears. The plate is the same treatment public/favicon.svg and logo-on-dark.svg use. */
function logoTile(h) {
  return '<span class="logo-plate">' + logoMark(h) + '</span>';
}
function topbar() {
  const u = state.user || {};
  const name = esc(u.name || '');
  const initials = esc(u.initials || initialsFor(u.name));
  return '<header class="topbar">' +
    '<a class="skip-link" href="#main-content">Skip to content</a>' +
    '<div class="brand">' +
      '<span class="logo">' + logoTile(28) + '</span>' +
      '<span class="brand-text">PipelineSync AI<small>Revenue operations blueprints</small></span>' +
    '</div>' +
    '<div class="topbar-right">' +
      '<div class="userchip" title="Signed in as ' + esc(u.email || '') + '">' +
        '<span class="userchip-av" aria-hidden="true">' + initials + '</span>' +
        '<span class="userchip-name"><b>' + name + '</b><small>' + esc(u.email || '') + '</small></span>' +
      '</div>' +
      '<button class="btn btn-ghost btn-sm" id="logout-btn" aria-label="Start over with another business">Start over</button>' +
    '</div>' +
  '</header>';
}
/* The step rail doubles as the progress bar: a compact count on phones, the full rail on
   desktop. Labels are wrapped in .label so CSS can drop them at narrow widths. */
function steps() {
  const order = ['intake', 'review', 'blueprint', 'done', 'booking'];
  const idx = state.stage === 'consent' ? 0 : state.stage === 'extracting' ? 1 : order.indexOf(state.stage);
  const labels = ['Discovery', 'Gap Analysis', 'Review', 'Blueprint', 'Next Steps'];
  const at = Math.max(0, Math.min(labels.length - 1, idx));
  const pct = Math.max(0, Math.min(100, Math.round(((at + 1) / labels.length) * 100)));
  let h = '<nav class="steps" aria-label="Progress">' +
    '<p class="steps-count">Step ' + (at + 1) + ' of ' + labels.length +
    '<span class="steps-now">' + esc(labels[at]) + '</span></p>' +
    '<div class="steps-rail" role="list">';
  labels.forEach((l, i) => {
    const cls = i < at ? 'done' : i === at ? 'active' : '';
    const aria = i === at ? ' aria-current="step"' : '';
    h += '<div class="step ' + cls + '"' + aria + ' role="listitem">' +
      '<span class="n" aria-hidden="true">' + (i < at ? '&#10003;' : (i + 1)) + '</span>' +
      '<span class="label">' + esc(l) + '</span></div>';
  });
  h += '</div></nav>';
  return h + '<div class="steps-bar" aria-hidden="true"><span style="width:' + pct + '%"></span></div>';
}
function footer() {
  return '<footer class="footer"><span>PipelineSync AI &bull; Revenue Operations</span><a href="/dev/outbox" target="_blank" rel="noopener">HubSpot outbox (dev)</a></footer>';
}

/* ---------------- the entry gate: name + email, then the AI voice call ----------------
 * There is no password and no account to create. The name is what the AI interviewer
 * calls the client on the call (sent as client_name on /api/voice/turn) and what lands
 * on the HubSpot lead. The email is where the finished blueprint PDF is delivered.
 * Production swaps this form for Supabase Auth (magic link or OTP) with the same shape. */
function initialsFor(name) {
  const parts = String(name || '').trim().split(/\s+/).filter(Boolean);
  if (!parts.length) return '?';
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
}
const NAME_RE = /[A-Za-z\u00C0-\u024F\u0400-\u04FF]/;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

function startView() {
  const lastName = store.get('ps_last_name') || '';
  const lastEmail = store.get('ps_last_email') || '';
  return '<div class="gate">' +
    '<div class="gate-brand">' +
      '<div class="gate-brand-inner">' +
        '<div class="telem cy mb12"><span class="d" aria-hidden="true"></span>AI ADVISOR READY &bull; STRATEGY DISCOVERY &bull; 12 SIGNALS</div>' +
        '<div class="brand brand-lg"><div class="logo">' + logoTile(38) + '</div><div class="brand-text">PipelineSync AI<small>Revenue Operations Strategy</small></div></div>' +
        '<h1>Turn your sales process into a <span class="accent">predictable pipeline.</span></h1>' +
        '<p class="lede">A 5-minute AI voice call to identify pipeline gaps, map sales velocity, and get your HubSpot blueprint.</p>' +
        '<ul class="mini-steps">' +
          '<li class="mini-step"><span class="n">1</span><div><b>Voice discovery</b><span>5-minute conversation with Alex</span></div></li>' +
          '<li class="mini-step"><span class="n">2</span><div><b>Gap analysis</b><span>Identify lost deals and friction</span></div></li>' +
          '<li class="mini-step"><span class="n">3</span><div><b>Review</b><span>Confirm your captured numbers</span></div></li>' +
          '<li class="mini-step"><span class="n">4</span><div><b>Blueprint</b><span>HubSpot setup &amp; ROI roadmap</span></div></li>' +
        '</ul>' +
        '<div class="gate-trust">' +
          '<span class="trust-item telem"><span class="d" aria-hidden="true"></span>5 mins</span>' +
          '<span class="trust-item telem"><span class="d" aria-hidden="true"></span>12 questions</span>' +
          '<span class="trust-item telem"><span class="d" aria-hidden="true"></span>Audio never stored</span>' +
        '</div>' +
      '</div>' +
    '</div>' +
    '<div class="gate-side"><div class="gate-card hud-frame specular">' +
      '<h2>Meet your AI advisor</h2>' +
      '<p class="sub">Enter your details to start the AI voice call.</p>' +
      '<form id="start-form" novalidate>' +
        '<div class="field-wrap"><label for="st-name">Your name <span class="req">Required</span></label>' +
          '<input type="text" id="st-name" name="name" class="field" value="' + esc(lastName) + '" placeholder="Maria Santos" maxlength="80" autocomplete="name" autocapitalize="words" spellcheck="false">' +
        '</div>' +
        '<div class="field-wrap mt16"><label for="st-email">Work email <span class="req">Required</span></label>' +
          '<input type="email" id="st-email" name="email" class="field" value="' + esc(lastEmail) + '" placeholder="you@yourbusiness.ph" maxlength="254" autocomplete="email" inputmode="email" spellcheck="false">' +
        '</div>' +
        '<p class="form-error" id="start-error" role="alert" hidden></p>' +
        '<button class="btn btn-primary btn-lg btn-block mt16" id="st-btn" type="submit">Start strategy session</button>' +
      '</form>' +
      '<div class="gate-alt"><span aria-hidden="true"></span>or<span aria-hidden="true"></span></div>' +
      '<button class="btn btn-ghost btn-block" id="demo-btn" type="button">Use demo account</button>' +
      '<p class="gate-note">Audio is transcribed live and never stored.</p>' +
    '</div></div>' +
  '</div>';
}
function bindStart() {
  const form = $('#start-form');
  const nameEl = $('#st-name');
  const emailEl = $('#st-email');
  const errEl = $('#start-error');
  const btn = $('#st-btn');
  const fail = (msg, focusEl) => {
    if (errEl) { errEl.textContent = msg; errEl.hidden = false; }
    if (focusEl) { focusEl.setAttribute('aria-invalid', 'true'); focusEl.focus(); }
    if (btn) { btn.disabled = false; btn.textContent = 'Start strategy session'; }
    const demoBtn = $('#demo-btn');
    if (demoBtn) { demoBtn.disabled = false; demoBtn.textContent = 'Use demo account'; }
    toast(msg, true);
  };
  const clearErrors = () => {
    if (errEl) { errEl.hidden = true; errEl.textContent = ''; }
    [nameEl, emailEl].forEach(el => { if (el) el.removeAttribute('aria-invalid'); });
  };
  const go = (name, email) => {
    const cleanName = String(name || '').replace(/\s+/g, ' ').trim();
    const cleanEmail = String(email || '').trim().toLowerCase();
    clearErrors();
    if (!cleanName || cleanName.length < 2) return fail('Enter your name so the AI knows what to call you on the call.', nameEl);
    if (!NAME_RE.test(cleanName)) return fail('Please enter your name using letters.', nameEl);
    if (!EMAIL_RE.test(cleanEmail)) return fail('Enter a valid email address, like you@yourbusiness.ph.', emailEl);
    if (btn) { btn.disabled = true; btn.textContent = 'Connecting you to the AI...'; }
    api.post('/api/auth/start', { name: cleanName, email: cleanEmail }).then(j => {
      state.token = j.token;
      state.user = j.user;
      saveAuth();
      store.set('ps_last_name', cleanName);
      store.set('ps_last_email', cleanEmail);
      state.stage = 'consent';
      render();
      toast('Ready when you are, ' + (j.user.first_name || cleanName.split(' ')[0]) + '.');
    }).catch(e => fail(e.message, nameEl));
  };
  if (form) form.addEventListener('submit', e => { e.preventDefault(); go(nameEl.value, emailEl.value); });
  const demo = $('#demo-btn');
  if (demo) demo.onclick = () => {
    clearErrors();
    demo.disabled = true;
    demo.textContent = 'Loading demo account...';
    go('Demo Owner', 'demo@pipelinesync.ai');
  };
  [nameEl, emailEl].forEach(el => { if (el) el.addEventListener('input', clearErrors); });
  // Put the cursor in the first empty field, and keep the keyboard out of the way on phones.
  if (nameEl && !nameEl.value) nameEl.focus();
  else if (emailEl && !emailEl.value) emailEl.focus();
}

/* ---------------- consent ---------------- */
function consentView() {
  return '<div class="card consent-card hud-frame specular">' +
    '<div class="telem cy mb12"><span class="d" aria-hidden="true"></span>SESSION TRANSPARENCY</div>' +
    '<h2>AI strategy session</h2>' +
    '<p class="sub">You are in control throughout the conversation.</p>' +
    '<div class="notice info">' +
      '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><circle cx="12" cy="12" r="10"/><path d="M12 16v-4M12 8h.01"/></svg>' +
      '<div><b>AI &amp; Privacy</b><br><span>We use OpenAI for the voice call to ask questions and transcribe your answers. Audio is never stored. Your answers are used solely to build your HubSpot blueprint.</span></div>' +
    '</div>' +
    '<label class="checkline"><input type="checkbox" id="consent-cb"> I understand how my data is used, and I agree to continue.</label>' +
    '<div class="btn-row"><button class="btn btn-primary btn-lg" id="consent-go" disabled>Agree and start the voice call</button></div>' +
    '<p class="small muted mt8" id="consent-note">Alex starts speaking automatically on agreement. You can skip questions or type anytime.</p>' +
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
  if (v.mode === 'realtime') return '<span class="badge-mode openai">Live AI voice</span>';
  const openai = v.mode === 'openai';
  return '<span class="badge-mode ' + (openai ? 'openai' : 'simulated') + '">' +
    (openai ? 'ChatGPT voice' : 'Simulated voice') + '</span>';
}
const QUESTION_TOPICS = {
  business: 'Business overview & target audience',
  products: 'Products, pricing & prerequisite milestones',
  deal: 'Deal size & sales team capacity',
  fulfilment: 'Service delivery & team headcount',
  owner: 'Marketing & operational leadership',
  close: 'Sales motion & buying journey',
  sources: 'Lead acquisition channels & tracking',
  capture: 'Lead capture & CRM infrastructure',
  volumes: 'Lead volume, conversion rate & cycle speed',
  spend: 'Marketing investment & software budget',
  headache: 'Operational bottlenecks & friction',
  goal: 'Growth targets & six-month milestones'
};
const TRACK_LABELS = [
  'Overview', 'Products', 'Deal size', 'Fulfilment',
  'Leadership', 'Sales motion', 'Lead sources', 'CRM stack',
  'Conversion', 'Budgets', 'Bottlenecks', 'Growth goal'
];

function voiceOrbHtml(status, listening) {
  const st = esc(status || 'idle');
  const isSpeakingOrListening = status === 'speaking' || listening;
  const waveHtml = '<div class="wave" aria-hidden="true">' +
    '<span></span><span></span><span></span><span></span><span></span><span></span><span></span><span></span><span></span>' +
    '</div>';
  return '<div class="voice-orb-container">' +
    '<div class="orb ' + st + (listening ? ' live' : '') + '" id="orb" role="img" aria-label="Call state: ' + st + '">' +
      '<div class="reticle" aria-hidden="true"><span></span><span></span><span></span><span></span></div>' +
      logoMark(44, '#FFFFFF') +
    '</div>' +
    (isSpeakingOrListening ? waveHtml : '') +
  '</div>';
}

function callView() {
  const v = voiceSync();
  const plan = v.plan || [];
  const total = plan.length || 12;
  const answered = state.answers.filter(a => String(a.text || '').trim()).length;
  const pct = Math.round((Math.min(answered, total) / total) * 100);
  const started = !!v.startedAt || v.transcript.length > 0;
  const statusText = (v.mode === 'realtime' ? RT_STATUS_TEXT[v.status] : VOICE_STATUS_TEXT[v.status]) ||
    VOICE_STATUS_TEXT[v.status] || VOICE_STATUS_TEXT.idle;
  const aiLine = v.lastLine || 'Alex, the PipelineSync AI interviewer, will call you. Twelve short questions about your business, all answered out loud. The AI speaks first, waits while you talk, then moves on.';
  const youLine = v.interim || v.lastHeard || '';

  const curQId = v.currentQuestionId || (plan[answered] && plan[answered].id) || 'business';
  const topic = QUESTION_TOPICS[curQId] || 'Business Discovery';

  let trackHtml = '<div class="business-track" role="list" aria-label="Discovery topics">';
  for (let i = 0; i < total; i++) {
    const isDone = i < answered;
    const isCur = i === answered && started && !v.done;
    const cls = isDone ? 'track-done' : (isCur ? 'track-active' : 'track-inactive');
    const label = TRACK_LABELS[i] || ('Topic ' + (i + 1));
    trackHtml += '<div class="track-step ' + cls + '" role="listitem">' +
      '<span class="track-dot" aria-hidden="true"></span>' +
      '<span class="track-name">' + esc(label) + '</span></div>';
  }
  trackHtml += '</div>';

  let h = '<div class="intake-wrap"><div class="call hud-frame">' +
    '<div class="call-head"><div class="who"><div class="avatar">AI</div><div><b>AI Discovery</b><span class="small muted" id="call-mode">' +
      (v.cfg ? (v.mode === 'openai' ? 'ChatGPT voice' : 'Simulated voice') : 'Connecting...') + '</span></div></div>' +
      '<div class="call-head-right"><div class="progress" id="call-progress">' + (started ? 'Question ' + Math.min(answered + 1, total) + ' of ' + total : 'Not started') + '</div>' +
      '<button class="btn btn-ghost btn-sm side-toggle" id="side-toggle" type="button" aria-expanded="' + (state.sideOpen ? 'true' : 'false') + '" aria-controls="intake-side">Progress<span class="side-toggle-count">' + answered + '/' + total + '</span></button></div></div>' +
    '<div class="progressbar"><div id="call-bar" style="width:' + pct + '%"></div></div>' +
    '<div class="call-body">' +
      trackHtml +
      '<div class="topic-chip"><span class="dot" aria-hidden="true"></span> ' + esc(topic) + '</div>' +
      voiceOrbHtml(v.status, v.listening) +
      '<div class="call-status" id="call-status" role="status" aria-live="polite">' + esc(statusText) + '</div>' +
      '<div class="line ai" id="ai-line" aria-live="polite">' + esc(aiLine) + '</div>' +
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
  const rt = v.rt;
  if (rt && (rt.live || rt.connecting)) {
    let h = '<div class="call-row">';
    h += '<button class="btn ' + (rt.micMuted ? 'btn-ghost' : 'btn-dark') + '" id="mic-btn" aria-pressed="' + (rt.micMuted ? 'false' : 'true') + '">' +
      (rt.micMuted ? 'Microphone muted' : 'Microphone live') + '</button>';
    h += '<button class="btn btn-ghost" id="repeat-btn">Repeat</button>';
    h += '<button class="btn btn-ghost" id="type-btn">Type instead</button>';
    h += '</div>';
    if (v.done) {
      h += '<div class="call-row"><button class="btn btn-primary btn-lg" id="structure-btn">Review what we heard</button></div>';
    }
    if (v.typed) {
      h += '<div class="chat-input"><textarea id="intake-input" rows="1" placeholder="Type your answer..."></textarea>' +
        '<button class="icon-btn" id="mic-back-btn" title="Answer out loud again">&#127908;</button>' +
        '<button class="btn btn-primary" id="send-btn">Send</button></div>';
    }
    return h;
  }
  if (!started) {
    return '<div class="call-row"><button class="btn btn-primary btn-lg" id="start-call">&#9654; Start discovery call</button>' +
      '<button class="btn btn-ghost" id="type-btn-pre">Type answers instead</button></div>';
  }
  let h = '<div class="call-row">';
  h += '<button class="btn ' + (v.listening ? 'btn-dark' : 'btn-primary') + '" id="mic-btn" aria-pressed="' + (v.listening ? 'true' : 'false') + '"' +
    (v.status === 'thinking' || v.done ? ' disabled' : '') + '>' +
    (v.listening ? '&#9632; Stop and send' : '&#127908; Tap to answer') + '</button>';
  h += '<button class="btn ' + (v.blockedAudio ? 'btn-primary' : 'btn-ghost') + '" id="repeat-btn">' + (v.blockedAudio ? '&#9654; Play' : 'Repeat') + '</button>';
  h += '<button class="btn btn-ghost" id="type-btn">Type instead</button>';
  if (v.currentQuestionId && !v.done) h += '<button class="btn btn-ghost" id="skip-btn">Skip</button>';
  h += '</div>';
  if (v.done) {
    h += '<div class="call-row"><button class="btn btn-primary btn-lg" id="structure-btn">Review what we heard</button></div>';
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
  const modeCard = '<div class="side-card"><h3>Session</h3>' +
    '<div class="provider-card">' + providerBadge() + '</div>' +
    '</div>';
  const errNote = state.fieldError ? '<p class="small txt-err mt8" role="alert">' + esc(state.fieldError) + '</p>' : '';
  const reqCard = missingReq.length
    ? '<div class="side-card warn"><h3>Needed for blueprint</h3><p class="small">Pending: <b>' + missingReq.map(k => esc(labels[k] || FIELD_LABELS[k])).join(', ') + '</b>.</p></div>'
    : '<div class="side-card ok"><h3>Required numbers captured</h3><p class="small">Deal size, lead volume, and close rate are captured.</p></div>';
  const bubbles = v.transcript.map(t => '<div class="bubble ' + (t.role === 'ai' ? 'ai' : 'user') + (t.ignored ? ' ignored' : '') + '">' +
    esc(t.text) + '</div>').join('');
  const transcriptCard = '<div class="side-card"><h3>Transcript</h3>' +
    '<details class="transcript" id="transcript-wrap"' + (state.showTranscript ? ' open' : '') + '><summary id="transcript-toggle">Show transcript (' + v.transcript.length + ' lines)</summary>' +
    '<div class="chat-body" id="chat-body">' + (bubbles || '<p class="small muted">Nothing yet.</p>') + '</div></details></div>';
  return '<aside class="intake-side" id="intake-side" aria-label="Call progress and captured answers">' +
    modeCard + '<div class="side-card"><h3>Captured signals</h3><div class="chip-col">' + chips + '</div>' + errNote + '</div>' + reqCard + transcriptCard + '</aside>';
}
/* The AI's line grows word by word on a live call, so it is patched in place rather than re-rendered
   (a full render would rebuild the orb and lose the animation mid-sentence). */
function updateAiLine() {
  const v = voiceSync();
  const el = $('#ai-line');
  if (el && v.lastLine) el.textContent = v.lastLine;
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
    // On a live call the microphone is already open: the button mutes it, it does not start a turn.
    if (v.rt && v.rt.live) { setRealtimeMicMuted(!v.rt.micMuted); render(); return; }
    if (v.listening) { stopListening(); return; }
    if (v.status === 'speaking') stopSpeaking();
    listNow();
  };
  const micBack = $('#mic-back-btn');
  if (micBack) micBack.onclick = () => {
    if (v.rt && v.rt.live) { v.typed = false; render(); return; }
    stopListening(); v.typed = false; render(); listNow();
  };
  const stopSpeak = $('#stop-speak');
  if (stopSpeak) stopSpeak.onclick = () => { stopSpeaking(); v.status = v.done ? 'complete' : 'ready'; render(); };
  const rep = $('#repeat-btn');
  if (rep) rep.onclick = () => { if (v.rt && v.rt.live) { realtimeRepeat(); return; } repeatLine(); };
  const typ = $('#type-btn');
  if (typ) typ.onclick = () => {
    stopListening();
    v.typed = true; v.status = 'ready'; render();
    const i = $('#intake-input'); if (i) i.focus();
  };
  const mute = $('#mute-btn');
  if (mute) mute.onclick = () => {
    if (v.rt && v.rt.live) { setRealtimeSpeakerMuted(!v.muted); render(); return; }
    v.muted = !v.muted; if (v.muted) stopSpeaking(); render();
  };
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
    // Typed words join the same live session, so the guardrail set records them the same way.
    if (v.rt && v.rt.live) { sendRealtimeText(t); return; }
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
  const triggerPersona = async (key) => {
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
  if (pg) pg.onclick = () => {
    const sel = $('#persona-sel');
    triggerPersona(sel ? sel.value : '');
  };
  document.querySelectorAll('[data-persona]').forEach(btn => {
    btn.onclick = () => triggerPersona(btn.getAttribute('data-persona'));
  });
  const tw = $('#transcript-wrap');
  if (tw) tw.addEventListener('toggle', () => { state.showTranscript = tw.open; });
  // On phones the captured-answers panel is a drawer under the call, opened from the call head.
  const sideToggle = $('#side-toggle');
  const wrapEl = $('.intake-wrap');
  if (sideToggle) sideToggle.onclick = () => {
    state.sideOpen = !state.sideOpen;
    if (wrapEl) wrapEl.classList.toggle('side-open', state.sideOpen);
    sideToggle.setAttribute('aria-expanded', state.sideOpen ? 'true' : 'false');
  };
  if (wrapEl) wrapEl.classList.toggle('side-open', state.sideOpen);
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
    state.fieldStatus = st;
    state.fieldError = null;
    render();
  } catch (e) {
    // Keep the hardening intent: a failed live preview is surfaced, not swallowed.
    state.fieldError = 'Could not update the live capture list: ' + e.message;
  }
}
function voiceMeta() {
  const v = state.voice;
  if (!v || !v.startedAt) return null;
  const end = v.endedAt ? new Date(v.endedAt) : new Date();
  const dur = Math.max(0, Math.round((end - new Date(v.startedAt)) / 1000));
  const rt = v.rt;
  const realtime = v.mode === 'realtime' || (rt && rt.startedAt);
  return {
    provider: v.provider, mode: v.mode,
    models: v.cfg ? v.cfg.models : null, tts_voice: v.cfg ? v.cfg.tts_voice : null,
    language: (v.cfg && v.cfg.language) || null,
    call_id: v.callId, started_at: v.startedAt, ended_at: v.endedAt,
    duration_s: dur, turns: v.turns,
    questions_asked: v.asked, probes: Object.keys(v.probes).length,
    required_missing_at_call_end: (v.capture && v.capture.missingRequired) || [],
    transcript_turns: v.transcript.length,
    transport: realtime ? 'webrtc-realtime' : 'turn-based',
    realtime_model: realtime ? (rt.model || (v.cfg && v.cfg.realtime && v.cfg.realtime.model) || null) : null,
    realtime_voice: realtime ? (rt.voice || (v.cfg && v.cfg.realtime && v.cfg.realtime.voice) || null) : null,
    turn_detection: realtime ? (rt.vad || (v.cfg && v.cfg.realtime && v.cfg.realtime.turn_detection) || null) : null,
    tool_calls: realtime ? (rt.toolCalls || 0) : null,
    captures_accepted: realtime ? (rt.accepted || 0) : null,
    captures_rejected: realtime ? (rt.rejected || 0) : null,
    fallback_to_turns: !!v.rtFallback,
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
  for (let i = 0; i < stepsEl.length; i++) {
    if (stepsEl[i]) stepsEl[i].className = 'lstep active';
    await sleep(600);
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
  const steps = [
    'Turning your conversation into a clear picture of your sales process',
    'Finding the gaps in your pipeline',
    'Matching the right HubSpot setup to your numbers',
    'Estimating what those leads are costing you'
  ];
  const title = kind === 'extracting'
    ? 'Turning your conversation into a clear picture of your sales process'
    : 'Generating your growth system blueprint';
  const sub = kind === 'extracting'
    ? 'Alex is structuring your conversation into a clear picture of your sales process. Unstated values are flagged as missing, never invented.'
    : 'Matching your numbers to proven HubSpot architectures, estimating the cost of inaction, and verifying implementation scope.';
  let h = '<div class="card loader hud-frame">' +
    '<div class="scanline-sweep" aria-hidden="true"></div>' +
    '<div class="loader-orb-wrap">' + voiceOrbHtml('thinking', false) + '</div>' +
    '<div class="telemetry-chip mb12"><span class="dot" aria-hidden="true"></span>AI ADVISOR SYNTHESIS &bull; ACTIVE</div>' +
    '<h2>' + title + '</h2><p class="sub">' + sub + '</p>';
  steps.forEach(s => { h += '<div class="lstep" role="status"><span class="ic" aria-hidden="true"></span>' + esc(s) + '</div>'; });
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
    let h = '<div class="review-group hud-frame"><h3>' + esc(title) + '</h3><div class="review-grid">';
    fields.forEach(cfg => {
      const v = f[cfg.k];
      const nullish = isNull(v);
      const req = cfg.required ? ' <span class="req">REQUIRED</span>' : '';
      const badge = nullish ? '<span class="nullbadge">We didn&#39;t capture this yet</span>' : '';
      const full = cfg.full ? ' review-full' : '';
      if (cfg.type === 'products') {
        const rows = (f.products || []).map((p, i) =>
          '<tr><td><input data-prod="' + i + '" data-pk="name" value="' + esc(p.name) + '" maxlength="200" aria-label="Product name"></td>' +
          '<td class="col-price"><input data-prod="' + i + '" data-pk="price" value="' + esc(p.price) + '" placeholder="PHP" aria-label="Product price"></td>' +
          '<td class="col-pre"><input data-prod="' + i + '" data-pk="prerequisite" value="' + esc(p.prerequisite) + '" placeholder="Needs..." maxlength="200" aria-label="Prerequisite"></td>' +
          '<td><button class="del" data-del-prod="' + i + '" title="Remove row" aria-label="Remove product">&times;</button></td></tr>'
        ).join('');
        h += '<div class="field review-full' + (nullish ? ' is-null' : '') + '"><label>Products and services ' + badge + '</label>' +
          '<div class="tbl-wrap"><table class="tbl tbl-edit"><tr><th>Product / service</th><th>Price</th><th>Prerequisite</th><th class="col-del"><span class="sr-only">Remove</span></th></tr>' + rows + '</table></div>' +
          '<button class="btn btn-ghost btn-sm mt8" id="add-prod">Add product</button></div>';
      } else if (cfg.type === 'sources') {
        const rows = (f.lead_sources || []).map((s, i) =>
          '<tr><td><input data-src="' + i + '" data-sk="source" value="' + esc(s.source) + '" maxlength="100" aria-label="Lead source"></td>' +
          '<td class="col-vol"><input data-src="' + i + '" data-sk="monthly_volume" value="' + esc(s.monthly_volume) + '" placeholder="per month" aria-label="Monthly volume"></td>' +
          '<td class="col-tracked"><select data-src="' + i + '" data-sk="tracked" aria-label="Tracked?">' +
          '<option value="unknown"' + (s.tracked == null ? ' selected' : '') + '>Unknown</option>' +
          '<option value="yes"' + (s.tracked === true ? ' selected' : '') + '>Tracked</option>' +
          '<option value="no"' + (s.tracked === false ? ' selected' : '') + '>Not tracked</option></select></td>' +
          '<td><button class="del" data-del-src="' + i + '" title="Remove row" aria-label="Remove source">&times;</button></td></tr>'
        ).join('');
        h += '<div class="field review-full' + (nullish ? ' is-null' : '') + '"><label>Lead sources ' + badge + '</label>' +
          '<div class="tbl-wrap"><table class="tbl tbl-edit"><tr><th>Source</th><th>Monthly volume</th><th>Tracked?</th><th class="col-del"><span class="sr-only">Remove</span></th></tr>' + rows + '</table></div>' +
          '<button class="btn btn-ghost btn-sm mt8" id="add-src">Add source</button></div>';
      } else if (cfg.type === 'tags') {
        h += '<div class="field' + full + '"><label>Current tools ' + badge + '</label>' +
          '<input data-key="' + cfg.k + '" type="text" value="' + esc(Array.isArray(v) ? v.join(', ') : (v || '')) + '" placeholder="Comma separated" maxlength="500"></div>';
      } else if (cfg.type === 'select') {
        const opts = cfg.options.map(o => '<option value="' + o + '"' + (v === o ? ' selected' : '') + '>' + o + '</option>').join('');
        h += '<div class="field' + (nullish ? ' is-null' : '') + full + '"><label>' + esc(cfg.label) + req + badge + '</label>' +
          '<select data-key="' + cfg.k + '" data-type="select"' + (v == null ? ' data-nullsel="1"' : '') + ' aria-label="' + esc(cfg.label) + '">' + (v == null ? '<option value="" selected>We didn&#39;t capture this yet - please select</option>' : '') + opts + '</select>' +
          (cfg.k === 'close_type' && nullish ? '<div class="small field-warn">Please select how you close - this affects pipeline stages</div>' : '') +
          (nullish ? heardNote(cfg.k) : '') + '</div>';
      } else if (cfg.type === 'textarea') {
        h += '<div class="field' + (nullish ? ' is-null' : '') + ' review-full"><label>' + esc(cfg.label) + req + badge + '</label>' +
          '<textarea data-key="' + cfg.k + '" data-type="text" maxlength="2000">' + esc(v) + '</textarea>' +
          (nullish ? heardNote(cfg.k) : '') + '</div>';
      } else {
        const ph = cfg.type === 'money' ? 'PHP amount' : cfg.type === 'number' ? 'Number' : 'Text';
        h += '<div class="field' + (nullish ? ' is-null' : '') + full + '"><label>' + esc(cfg.label) + req + badge + '</label>' +
          '<input data-key="' + cfg.k + '" data-type="' + (cfg.type === 'money' || cfg.type === 'number' ? 'number' : 'text') + '" value="' + esc(v) + '" placeholder="' + ph + '" maxlength="200">' +
          (nullish ? heardNote(cfg.k) : '') + '</div>';
      }
    });
    return h + '</div></div>';
  };
  const groups = [
    ['1. Commercial Foundation & Deal Economics', [
      { k: 'typical_deal_size', label: 'Typical deal size', type: 'money', required: true },
      { k: 'monthly_lead_volume', label: 'Monthly lead volume', type: 'number', required: true },
      { k: 'close_rate', label: 'Close rate (%)', type: 'number', required: true },
      { k: 'monthly_deal_volume', label: 'Monthly deal volume', type: 'number' },
      { k: 'sales_cycle_length', label: 'Sales cycle length (weeks)', type: 'number' }
    ]],
    ['2. Pipeline Motion & Buying Journey', [
      { k: 'close_type', label: 'Close type', type: 'select', options: ['one-call', 'two-call'] },
      { k: 'sales_reps_on_calls', label: 'Sales reps on calls', type: 'number' },
      { k: 'sales_process_notes', label: 'Sales process notes', type: 'textarea' }
    ]],
    ['3. Lead Channels & Technology Stack', [
      { k: 'lead_sources', label: '', type: 'sources', full: true },
      { k: 'lead_capture_method', label: 'Lead capture method', type: 'text' },
      { k: 'current_crm', label: 'Current CRM', type: 'text' },
      { k: 'current_hubspot_tier', label: 'Current HubSpot tier', type: 'text' },
      { k: 'current_tools', label: '', type: 'tags', full: true }
    ]],
    ['4. Operations & Service Fulfilment', [
      { k: 'industry', label: 'Industry (vertical)', type: 'text' },
      { k: 'business_description', label: 'Business description', type: 'textarea' },
      { k: 'products', label: '', type: 'products', full: true },
      { k: 'fulfilment_headcount', label: 'Fulfilment headcount', type: 'number' },
      { k: 'fulfilment_method', label: 'Fulfilment method', type: 'text' },
      { k: 'marketing_ops_owner', label: 'Marketing and ops owner', type: 'text' }
    ]],
    ['5. Growth Bottlenecks & Strategic Milestones', [
      { k: 'biggest_headache', label: 'Biggest headache', type: 'textarea' },
      { k: 'six_month_goal', label: 'Six-month goal', type: 'textarea' },
      { k: 'monthly_marketing_spend', label: 'Monthly marketing spend', type: 'money' },
      { k: 'monthly_software_budget', label: 'Monthly software budget', type: 'money' }
    ]]
  ];
  const v = state.voice;
  const callLine = v && v.startedAt
    ? '<div class="call-summary">' + providerBadge() + ' <span class="small muted">' + (v.mode === 'openai' ? 'ChatGPT voice' : 'Simulated voice') +
      ' &bull; ' + v.turns + ' turns &bull; audio not retained</span></div>'
    : '';
  let h = '<div class="card hud-frame"><div class="telemetry-chip mb12"><span class="dot" aria-hidden="true"></span>SESSION INTELLIGENCE &bull; VERIFIED</div>' +
    '<h2>Review what we heard</h2>' + callLine +
    '<p class="sub">Verify your core commercial numbers and operational details before generating your blueprint.</p>';
  groups.forEach(g => { h += groupHtml(g[0], g[1]); });
  h += '<div class=\"btn-row\"><button class=\"btn btn-primary\" id=\"confirm-fields\">Review my plan</button>' +
    '<button class=\"btn btn-ghost\" id=\"back-intake\">Back to call</button></div>' +
    '<p class=\"small muted mt8\" id=\"confirm-hint\" role=\"status\"></p></div>';
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
    const missingClose = f.close_type == null;
    let msg = '';
    if (missing.length) msg += 'Still needed before we can generate: ' + missing.map(k => FIELD_LABELS[k]).join(', ') + '. ';
    if (missingClose) msg += 'Please select Close type (one-call or two-call). ';
    if (!msg) msg = 'All required numbers are set. The blueprint will be grounded in these figures.';
    hint.textContent = msg;
    hint.style.color = (missing.length || missingClose) ? 'var(--amber)' : 'var(--green)';
    const btn = $('#confirm-fields');
    if (btn) btn.disabled = missing.length > 0 || missingClose;
  };
  check();
  $('#confirm-fields').onclick = () => {
    const f = collectFields();
    if (f.close_type == null) {
      toast('Please select Close type before generating', true);
      return;
    }
    startGeneration(f);
  };
  $('#back-intake').onclick = () => { state.stage = 'intake'; render(); };
  const addProd = $('#add-prod');
  if (addProd) addProd.onclick = () => {
    const f = collectFields();
    state.fields = f;
    state.fields.products.push({ name: '', price: null, prerequisite: null });
    render();
    setTimeout(() => {
      const last = document.querySelector('[data-prod]:last-of-type');
      if (last) last.focus();
      checkRefocus('confirm-fields');
    }, 0);
  };
  const addSrc = $('#add-src');
  if (addSrc) addSrc.onclick = () => {
    const f = collectFields();
    state.fields = f;
    state.fields.lead_sources.push({ source: '', monthly_volume: null, tracked: null });
    render();
    setTimeout(() => {
      const last = document.querySelector('[data-src]:last-of-type');
      if (last) last.focus();
      checkRefocus('confirm-fields');
    }, 0);
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
  document.querySelectorAll('input[data-key], textarea[data-key], select[data-key], [data-prod], [data-src]').forEach(el => {
    el.addEventListener('input', () => {
      const f = collectFields();
      state.fields = f;
      check();
    });
    el.addEventListener('change', () => {
      const f = collectFields();
      state.fields = f;
      check();
    });
  });
  // Focus first required empty field
  const firstEmpty = document.querySelector('.field.is-null input, .field.is-null select');
  if (firstEmpty) firstEmpty.focus();
}
function checkRefocus(id) {
  const btn = document.getElementById(id);
  const hint = $('#confirm-hint');
  if (hint && btn) {
    const f = collectFields();
    const missing = REQUIRED.filter(k => f[k] == null || isNaN(f[k]) || f[k] <= 0);
    const missingClose = f.close_type == null;
    let msg = '';
    if (missing.length) msg += 'Still needed before we can generate: ' + missing.map(k => FIELD_LABELS[k]).join(', ') + '. ';
    if (missingClose) msg += 'Please select Close type. ';
    if (!msg) msg = 'All required numbers are set. The blueprint will be grounded in these figures.';
    hint.textContent = msg;
    hint.style.color = (missing.length || missingClose) ? 'var(--amber)' : 'var(--green)';
    btn.disabled = missing.length > 0 || missingClose;
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
function animateNumbers() {
  if (typeof window === 'undefined') return;
  document.querySelectorAll('.count-up').forEach(el => {
    const raw = el.getAttribute('data-val') || el.textContent;
    const num = parseFloat(raw.replace(/[^0-9.-]/g, ''));
    if (isNaN(num)) return;
    const prefix = raw.startsWith('+') ? '+' : (raw.startsWith('-') ? '-' : (raw.startsWith('PHP') ? 'PHP ' : ''));
    const suffix = raw.endsWith('%') ? '%' : '';
    let start = 0;
    const dur = 900;
    const t0 = (typeof performance !== 'undefined' && performance.now) ? performance.now() : Date.now();
    function tick(now) {
      const p = Math.min((now - t0) / dur, 1);
      const ease = 1 - Math.pow(1 - p, 3);
      const cur = Math.round(start + (num - start) * ease);
      el.textContent = prefix + cur.toLocaleString('en-US') + suffix;
      if (p < 1 && typeof requestAnimationFrame !== 'undefined') requestAnimationFrame(tick);
      else el.textContent = raw;
    }
    if (typeof requestAnimationFrame !== 'undefined') requestAnimationFrame(tick);
    else el.textContent = raw;
  });
}

function blueprintView() {
  const bp = state.blueprint;
  const stageCls = s => s === 'Closed Won' ? ' won' : s === 'Closed Lost' ? ' lost' : '';
  const stages = bp.pipeline.stages.map((s, i) => {
    const isWon = s === 'Closed Won', isLost = s === 'Closed Lost';
    const isSla = i === 1;
    const cls = isWon ? ' won' : (isLost ? ' lost' : (isSla ? ' pipeline-sla-stage' : ''));
    const slaBadge = isSla ? '<span class="sla-badge">⚡ 5-MIN SLA</span> ' : '';
    const arrow = (i < bp.pipeline.stages.length - 1)
      ? '<span class="pipeline-flow-connector" aria-hidden="true">' +
          '<svg class="pipeline-connector-svg" viewBox="0 0 32 18">' +
            '<line x1="2" y1="9" x2="30" y2="9" stroke="rgba(34,211,238,0.4)" stroke-width="2" stroke-dasharray="4 4"/>' +
            '<circle cx="16" cy="9" r="3" fill="var(--cyan)"><animate attributeName="cx" values="4;28;4" dur="2.4s" repeatCount="indefinite"/></circle>' +
          '</svg>' +
        '</span>'
      : '';
    return '<span class="stage' + cls + '">' + slaBadge + esc(s) + '</span>' + arrow;
  }).join('');

  const gapText = (state.fields && state.fields.biggest_headache)
    ? esc(state.fields.biggest_headache)
    : 'Delayed inbound lead response and unmonitored drop-off between inquiry and qualification.';
  const changeText = 'Deploy automated 5-minute lead distribution and standardise the ' + esc(bp.pipeline.variant) + ' qualification pipeline in HubSpot Sales Hub ' + esc(bp.stack.tier.replace(/HubSpot\s*/i, '')) + ' to eliminate pipeline leakage.';
  const gapCards = '<div class="gap-card"><h4>⚡ The biggest operational gap</h4><p>' + gapText + '</p></div>' +
    '<div class="change-card"><h4>✦ The single most important change</h4><p>' + changeText + '</p></div>';

  const heroStats = [
    { v: '-35%', l: 'Sales cycle velocity acceleration' },
    { v: '+18%', l: 'Projected close rate lift' },
    { v: fmtMoney(bp.coa.totalMonthly), l: 'Monthly revenue reclaimed' }
  ];
  const impactHtml = heroStats.map((s, i) =>
    '<div class="stat">' +
      '<div class="k' + (i === 2 ? ' am' : '') + ' count-up" data-val="' + esc(s.v) + '">' + esc(s.v) + '</div>' +
      '<div class="l">' + esc(s.l) + '</div>' +
    '</div>'
  ).join('');

  const priorityActions = [
    { t: '1. Establish rapid lead SLA', d: 'Enforce under-5-minute contact SLA on all high-intent digital inbound leads with automated rep notifications.' },
    { t: '2. Formalise qualification gates', d: 'Standardise stage advancement criteria in HubSpot so unqualified inquiries do not clutter senior sales reps.' },
    { t: '3. Plug attribution blind spots', d: 'Connect paid ad channels and website forms directly into CRM deals to eliminate spreadsheet lag.' }
  ];
  const actionsHtml = '<div class="priority-actions-grid">' +
    priorityActions.map(a => '<div class="priority-action"><h4>' + esc(a.t) + '</h4><p class="small">' + esc(a.d) + '</p></div>').join('') +
    '</div>';

  const tools = bp.tools.length
    ? '<div class="tbl-wrap"><table class="tbl"><thead><tr><th>Tool</th><th>Recommendation</th><th>Why</th></tr></thead><tbody>' +
      bp.tools.map(t => {
        const cls = t.action.toLowerCase().includes('keep') ? 'action-keep' : t.action.toLowerCase().includes('upgrade') ? 'action-upgrade' : t.action.toLowerCase().includes('replace') ? 'action-replace' : 'action-consolidate';
        return '<tr><td><b>' + esc(t.name) + '</b></td><td class=\"' + cls + '\">' + esc(t.action) + '</td><td class=\"small\">' + esc(t.reason) + '</td></tr>';
      }).join('') + '</tbody></table></div>'
    : '<p class=\"muted\">No tools were stated. The stack is reviewed at the build call.</p>';
  const srcs = bp.leadSources.map(s =>
    '<li><b>' + esc(s.name) + '</b> (' + (s.monthlyVolume != null ? s.monthlyVolume : '?') + '/mo, ' + (s.tracked === false ? 'currently untracked' : s.tracked === true ? 'tracked' : 'tracking unclear') + '): ' + esc(s.mechanism) + '</li>'
  ).join('');
  const coa = bp.coa.items.map(c =>
    '<div class=\"coa-item\"><div class=\"t\">' + esc(c.title) + '</div><div class=\"v\">' + fmtMoney(c.value) + ' <span class=\"small muted\">(' + esc(c.period) + ')</span></div>' +
    '<div class=\"b\">Basis: ' + esc(c.basis) + '</div></div>'
  ).join('');
  const compliance = bp.compliance.length
    ? bp.compliance.map(c => '<div class=\"compliance-flag\"><span class=\"code\">' + esc(c.code) + '</span><span>' + esc(c.note) + '</span></div>').join('')
    : '<p class=\"muted\">No compliance flags in knowledge base v1 for this vertical.</p>';
  const kbChips = bp.kbReferences.map(r => '<span class=\"chip kb\">' + esc(r) + '</span>').join('');
  const delivered = state.delivered;

  let h = '<div class=\"doc hud-frame\">' +
    '<div class=\"doc-head\"><div class=\"telem cy mb12\"><span class=\"d\" aria-hidden=\"true\"></span>HUBSPOT BLUEPRINT VERIFIED &bull; TIER FLOOR: PRO</div>' +
    '<div class=\"kicker\">PIPELINESYNC AI  |  ' + esc(bp.meta.verticalLabel).toUpperCase() + '</div>' +
    '<h2>Your growth system</h2>' +
    '<div class=\"meta\">' + esc(bp.meta.businessLine) + '  |  Prepared ' + esc(bp.meta.date) + '  |  ' + esc(bp.meta.generatedBy) + '</div></div>' +
    '<h3 class=\"sec\"><span class=\"sn\">1</span>Executive summary</h3>' +
    '<p>' + esc(bp.summary.text) + '</p>' +
    gapCards +
    '<div class=\"stat-row\">' + impactHtml + '</div>' +
    actionsHtml +
    '<h3 class=\"sec\"><span class=\"sn\">2</span>Recommended HubSpot stack</h3>' +
    '<ul><li><b>Core:</b> ' + esc(bp.stack.tier) + '</li>' +
    bp.stack.addOns.map(a => '<li><b>Add-on:</b> ' + esc(a) + '</li>').join('') +
    '<li>' + esc(bp.stack.pricingLine) + '</li></ul>' +
    '<p class=\"small muted\">' + esc(bp.stack.pricingNote) + '</p>' +
    '<ul>' + bp.stack.rationale.map(r => '<li>' + esc(r) + '</li>').join('') + '</ul>' +
    '<h3 class=\"sec\"><span class=\"sn\">3</span>Pipeline architecture</h3>' +
    '<p>' + esc(bp.pipeline.label) + ' (' + esc(bp.pipeline.variant) + ' close). ' + esc(bp.pipeline.note) + '</p>' +
    '<div class=\"stage-flow\">' + stages + '</div>' +
    '<ul>' + bp.pipeline.workflows.map(w => '<li>Workflow: ' + esc(w) + '</li>').join('') + '</ul>' +
    '<h3 class=\"sec\"><span class=\"sn\">4</span>Lead source architecture</h3>' +
    (srcs ? '<ul>' + srcs + '</ul>' : '<p class=\"muted\">No lead sources were stated.</p>') +
    '<h3 class=\"sec\"><span class=\"sn\">5</span>Tool mapping (current to recommended)</h3>' + tools +
    '<h3 class=\"sec\"><span class=\"sn\">6</span>Build plan</h3>' +
    '<p><b>Confirmed defaults (included in the tier):</b></p><ul>' + bp.build.defaults.map(d => '<li>' + esc(d) + '</li>').join('') + '</ul>' +
    '<p><b>Custom items to create for you:</b></p><ul>' + bp.build.custom.map(d => '<li>' + esc(d) + '</li>').join('') + '</ul>' +
    '<h3 class=\"sec\"><span class=\"sn\">7</span>What those gaps are costing you</h3>' + coa +
    '<div class=\"coa-total\">Total estimated cost of inaction: <b>' + fmtMoney(bp.coa.totalMonthly) + ' per month</b>, ' + fmtMoney(bp.coa.totalSix) + ' over six months.</div>' +
    '<h3 class=\"sec\"><span class=\"sn\">8</span>Compliance</h3>' + compliance +
    '<h3 class=\"sec\"><span class=\"sn\">9</span>Next steps</h3><ol>' + bp.nextSteps.map(s => '<li>' + esc(s) + '</li>').join('') + '</ol>' +
    '<div class=\"doc-foot\">Sourced exclusively from knowledge base v1 (no invented properties, tools, features, or prices):<div class=\"chip-row mt8\">' + kbChips + '</div>' +
    '<p class=\"mt8\">Generated by PipelineSync AI from your confirmed answers. Figures are planning estimates, not a quote. Prepared in UK English.</p></div>' +
    '</div>';

  h += '<div class=\"btn-row\">' +
    (delivered
      ? '<button class=\"btn btn-ghost\" id=\"redownload-btn\" aria-label=\"Download PDF again\">&#11015; Download ' + esc(delivered.filename) + '</button>' +
        '<button class=\"btn btn-amber\" id=\"book-btn\">Talk to a consultant</button>'
      : '<button class=\"btn btn-primary btn-lg\" id=\"unlock-btn\">Download the blueprint</button>' +
        '<button class=\"btn btn-amber\" id=\"book-btn\">Talk to a consultant</button>') +
    '</div>';

  if (delivered) {
    h += '<div class=\"success-card\" role=\"status\"><h3>&#10003; PDF delivered and lead captured</h3>' +
      '<div class=\"kv\"><span class=\"k\">HubSpot contact ID</span><span class=\"v mono\">' + esc(delivered.contact_id) + '</span></div>' +
      '<div class=\"kv\"><span class=\"k\">Delivered to</span><span class=\"v\">' + esc(delivered.email) + '</span></div>' +
      '<div class=\"kv\"><span class=\"k\">File</span><span class=\"v\">' + esc(delivered.filename) + '</span></div></div>';
  } else {
    h += '<div id=\"unlock-holder\"></div>';
  }
  return h;
}
function bindBlueprint() {
  const newBiz = $('#new-biz');
  if (newBiz) newBiz.onclick = () => { resetJourney(); render(); };
  const bb = $('#book-btn');
  if (bb) bb.onclick = () => { state.stage = 'booking'; render(); };
  const rd = $('#redownload-btn');
  if (rd) rd.onclick = () => downloadPdf(state.delivered);
  const ub = $('#unlock-btn');
  if (ub) ub.onclick = () => {
    const holder = $('#unlock-holder');
    holder.innerHTML = '<div class=\"unlock-panel\"><h3 class="unlock-title">Download your blueprint</h3>' +
      '<div class=\"grid-2\"><div class=\"field\"><label for=\"un-email\">Email for delivery</label><input type=\"email\" id=\"un-email\" value=\"' + esc(state.user.email) + '\" maxlength=\"254\"></div>' +
      '<div class="field field-check"><label class="checkline"><input type=\"checkbox\" id=\"un-consent\"> I agree to receive the PDF and to be contacted about the build.</label></div></div>' +
      '<button class=\"btn btn-primary\" id=\"un-go\" disabled>Generate and send my PDF</button></div>';
    const cb = $('#un-consent'), go = $('#un-go');
    cb.onchange = () => { go.disabled = !cb.checked; };
    const emailInput = $('#un-email');
    if (emailInput) emailInput.focus();
    go.onclick = async () => {
      go.disabled = true; go.textContent = 'Generating PDF...';
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
  // Focus management
  const main = $('#main-content');
  if (main) main.focus();
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
  // DST-safe: use setDate instead of +86400000
  let cursor = new Date(now);
  cursor.setHours(0,0,0,0);
  cursor.setDate(cursor.getDate() + 1);
  while (days.length < 7) {
    if (cursor.getDay() !== 0 && cursor.getDay() !== 6) {
      days.push(new Date(cursor));
    }
    cursor.setDate(cursor.getDate() + 1);
  }
  const dayStrs = days.map(x => x.toISOString().slice(0, 10));
  const slots = ['09:00', '10:00', '11:00', '13:00', '14:00', '15:00'];
  const b = state.booking || {};
  const dayBtns = days.map((x, i) => {
    const sel = b.day === dayStrs[i];
    return '<button class=\"day' + (sel ? ' sel' : '') + '\" data-day=\"' + dayStrs[i] + '\" aria-pressed=\"' + (sel ? 'true' : 'false') + '\" aria-label=\"' + esc(x.toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'long' })) + '\"><div class=\"dow\" aria-hidden=\"true\">' +
    x.toLocaleDateString('en-GB', { weekday: 'short' }) + '</div><div class=\"dnum\" aria-hidden=\"true\">' + x.getDate() + '</div></button>';
  }).join('');
  const slotBtns = slots.map(s => {
    const sel = b.day && b.slot === s;
    const disabled = !b.day;
    return '<button class=\"slot' + (sel ? ' sel' : '') + '\" data-slot=\"' + s + '\"' + (disabled ? ' disabled aria-disabled=\"true\"' : '') + ' aria-pressed=\"' + (sel ? 'true' : 'false') + '\" aria-label=\"Book at ' + esc(s) + '\">' + esc(s) + '</button>';
  }).join('');
  let h = '<div class=\"booking\"><div class=\"card\"><h2>Schedule consultation</h2>' +
    '<p class=\"sub\">30-minute scope walk-through with our build team.</p>' +
    '<h3 class="pick-label">Select date</h3><div class="day-strip" role="group" aria-label="Pick a day">' + dayBtns + '</div>' +
    '<h3 class="pick-label">Select time</h3><div class="slot-grid" role="group" aria-label="Pick a time">' + slotBtns + '</div>' +
    '<div class=\"btn-row\">' +
    '<button class=\"btn btn-primary\" id=\"book-go\" ' + (b.day && b.slot ? '' : 'disabled') + ' aria-label=\"Request this slot\">Confirm slot</button>' +
    '<button class=\"btn btn-ghost\" id=\"back-blueprint\">Back</button></div>' +
    '</div>';
  if (state.booking && state.booking.confirmed) {
    h += '<div class=\"success-card\" role=\"status\"><h3>&#10003; Meeting requested</h3>' +
      '<div class=\"kv\"><span class=\"k\">When</span><span class=\"v\">' + esc(state.booking.day) + ' at ' + esc(state.booking.slot) + '</span></div>' +
      '<div class=\"kv\"><span class=\"k\">Duration</span><span class=\"v\">30 minutes</span></div>' +
      '<div class=\"kv\"><span class=\"k\">With</span><span class=\"v\">PipelineSync build lead</span></div></div>' +
      '<div class=\"btn-row\"><button class=\"btn btn-dark\" id=\"finish-btn\">Finish</button></div>';
  }
  return h + '</div>';
}
function bindBooking() {
  document.querySelectorAll('[data-day]').forEach(el => {
    const handler = () => {
      state.booking = { day: el.getAttribute('data-day'), slot: null };
      render();
    };
    el.onclick = handler;
    el.onkeydown = (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); handler(); } };
  });
  document.querySelectorAll('[data-slot]').forEach(el => {
    const handler = () => {
      if (!state.booking) state.booking = { day: null, slot: null };
      state.booking.slot = el.getAttribute('data-slot');
      render();
    };
    el.onclick = handler;
    el.onkeydown = (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); handler(); } };
  });
  const go = $('#book-go');
  if (go) go.onclick = () => {
    go.disabled = true;
    state.booking.confirmed = true;
    render();
  };
  const bb = $('#back-blueprint');
  if (bb) bb.onclick = () => { state.stage = 'blueprint'; render(); };
  const fin = $('#finish-btn');
  if (fin) fin.onclick = () => { state.stage = 'done'; render(); };
  const firstDay = document.querySelector('[data-day]');
  if (firstDay && !state.booking?.day) firstDay.focus();
}

/* ---------------- done ---------------- */
function doneView() {
  const bp = state.blueprint;
  const d = state.delivered;
  const b = state.booking;
  let h = '<div class="card done-card">' +
    '<div class="done-mark">' + logoTile(54) + '</div>' +
    '<h2>Your blueprint is on its way</h2>' +
    '<p class=\"sub\">Your strategy session is complete.</p>' +
    '<div class="done-list">' +
    '<div class=\"kv\"><span class=\"k\">Blueprint</span><span class=\"v\">' + (bp ? esc(bp.meta.verticalLabel) + ', ' + esc(bp.stack.tier) : 'n/a') + '</span></div>' +
    '<div class=\"kv\"><span class=\"k\">PDF</span><span class=\"v\">' + (d ? esc(d.filename) : 'not unlocked') + '</span></div>' +
    '<div class=\"kv\"><span class=\"k\">HubSpot lead</span><span class=\"v mono\">' + (d ? esc(d.contact_id) : 'not created') + '</span></div>' +
    '<div class=\"kv\"><span class=\"k\">Consultation</span><span class=\"v\">' + (b && b.confirmed ? esc(b.day) + ' at ' + esc(b.slot) : 'not scheduled') + '</span></div>' +
    '</div>' +
    '<div class="btn-row btn-row-center">' +
    '<button class=\"btn btn-primary\" id=\"new-biz2\">Run another business</button>' +
    '</div>' +
    '</div>';
  return h;
}
function bindDone() {
  const n = $('#new-biz2');
  if (n) {
    n.onclick = () => { resetJourney(); render(); };
    n.focus();
  }
}

/* ---------------- global bindings + boot ---------------- */
function bindGlobal() {
  const lo = $('#logout-btn');
  if (lo) lo.onclick = async () => {
    try { await api.post('/api/auth/logout', {}); } catch (e) {}
    state.token = null; state.user = null; saveAuth(); resetJourney(); state.stage = 'start';
    render();
  };
}
function routeBindings() {
  bindGlobal();
  switch (state.stage) {
    case 'start': bindStart(); break;
    case 'consent': {
      const cb = $('#consent-cb'), go = $('#consent-go');
      if (cb && go) {
        cb.onchange = () => { go.disabled = !cb.checked; };
        const note = $('#consent-note');
        if (note) note.textContent = voiceReady()
          ? 'Agree and the AI starts speaking straight away, then it listens while you answer out loud.'
          : 'Agree and the AI starts speaking, then it listens while you answer out loud. Preparing the voice now...';
        // The call plan and the opening line are fetched while the client reads the notice, so the
        // AI can speak inside the click that agrees to it.
        prefetchOpening();
        go.onclick = () => beginCall();
        cb.focus();
      }
      break;
    }
    case 'intake': bindCall(); break;
    case 'review': bindReview(); break;
    case 'blueprint': bindBlueprint(); break;
    case 'booking': bindBooking(); break;
    case 'done': bindDone(); break;
  }
  // Focus main content for screen readers after navigation
  const main = document.getElementById('main-content');
  if (main && state.stage !== 'intake' && state.stage !== 'start') {
    // Don't steal focus from inputs, only if no active input
    const active = document.activeElement;
    const isInput = active && (active.tagName === 'INPUT' || active.tagName === 'TEXTAREA' || active.tagName === 'SELECT' || active.tagName === 'BUTTON');
    if (!isInput) {
      // Use timeout to ensure DOM is ready
      setTimeout(() => { if (document.getElementById('main-content')) document.getElementById('main-content').focus({ preventScroll: true }); }, 50);
    }
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
