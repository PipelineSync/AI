(function () {
'use strict';
/*
 * Nova PipelineSync AI - prototype frontend (vanilla JS, no CDN, works offline in preview)
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
const sessionStore = {
  get: k => { try { return window.sessionStorage.getItem(k); } catch (e) { return null; } },
  set: (k, v) => { try { window.sessionStorage.setItem(k, v); } catch (e) {} },
  remove: k => { try { window.sessionStorage.removeItem(k); } catch (e) {} }
};
const KNOWN_STAGES = new Set(['consent','intake','extracting','review','generating','blueprint','booking','done']);
function saveJourneyState() {
  if (!state.token) return;
  try {
    const data = {
      stage: state.stage,
      answers: state.answers,
      fields: state.fields,
      jobId: state.jobId
    };
    sessionStore.set('ps_journey', JSON.stringify(data));
  } catch (e) {}
}
function restoreJourneyState() {
  if (!state.token) return false;
  try {
    const raw = sessionStore.get('ps_journey');
    if (!raw) return false;
    const data = JSON.parse(raw);
    if (!data || typeof data !== 'object') return false;
    let restored = false;
    if (data.stage && typeof data.stage === 'string' && KNOWN_STAGES.has(data.stage)) {
      state.stage = data.stage;
      restored = true;
    }
    if (Array.isArray(data.answers)) {
      state.answers = data.answers;
      restored = true;
    }
    if (data.fields && typeof data.fields === 'object') {
      state.fields = data.fields;
      restored = true;
    }
    if (data.jobId && typeof data.jobId === 'string') {
      state.jobId = data.jobId;
      restored = true;
    }
    return restored;
  } catch (e) {
    return false;
  }
}


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
/* Dark-only premium glass theme: no colour-mode switch, theme is always dark. */
const state = {
  token: store.get('ps_token') || null,
  user: JSON.parse(store.get('ps_user') || 'null'),
  theme: 'dark',
  stage: 'start',        // the entry gate: name + email, then straight to the voice call
  answers: [],           // [{id, text}] captured on the call (or by typing)
  fields: null,          // Section 7 contract (from job record now)
  blueprint: null,
  jobId: null,           // server-side job id for blueprint
  delivered: null,       // {contact_id, filename, pdf_base64, email, email_result, hubspot, duplicate, persistence}
  booking: null,         // {day, slot}
  schedulerLink: null, // from /api/config (SCHEDULER_LINK env)
  turnstileSiteKey: null, // from /api/config when TURNSTILE_SITE_KEY is set
  demoMode: false,     // from /api/config when DEMO_MODE=true
  privacyPolicyUrl: null, // from /api/config when PRIVACY_POLICY_URL is https
  consentVersion: null, // from /api/config (CONSENT_VERSION)
  turnstileToken: null,// filled by Turnstile widget callback
  hubspot: null,       // {ok, mocked, contactId?} from /api/auth/start
  fieldStatus: {},       // live sidebar state
  voice: null,           // live call state (see newVoiceState in the voice engine)
  showTranscript: false, // transcript panel is collapsed; the call is spoken
  sideOpen: false,       // mobile: the call progress panel is a drawer
  fieldError: null,      // live capture status problems, surfaced instead of failing silently
  fieldErrors: null,     // per-field errors returned by the server-side re-validation
  progress: null,        // real generation progress from /api/generate/status: {label, percent}
  blueprintSource: null,  // 'claude' | 'fallback', as reported by the API
  emailVerify: { code: '', sending: false, sent: false, error: null } // for EMAIL_VERIFY flow
};
function saveAuth() {
  store.set('ps_token', state.token || '');
  store.set('ps_user', JSON.stringify(state.user || {}));
}
function resetJourney() {
  stopSpeaking(); stopListening();
  state.stage = 'consent'; state.answers = []; state.fields = null;
  state.blueprint = null; state.jobId = null; state.delivered = null; state.booking = null; state.fieldStatus = {};
  state.hubspot = null;
  state.voice = null; state.showTranscript = false; state.sideOpen = false; state.fieldError = null;
  state.fieldErrors = null; state.progress = null; state.blueprintSource = null;
  state.emailVerify = { code: '', sending: false, sent: false, error: null };
  sessionStore.remove('ps_journey');
}

/* ---------------- api ---------------- */
const api = {
  async post(p, body) {
    const controller = typeof AbortController !== 'undefined' ? new AbortController() : null;
    const timeoutId = controller ? setTimeout(() => controller.abort(), 25000) : null;
    try {
      const r = await fetch(p, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(Object.assign({ token: state.token }, body)),
        signal: controller ? controller.signal : undefined
      });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) {
        if (r.status === 401) { state.token = null; state.user = null; saveAuth(); state.stage = 'start'; render(); }
        const err = new Error(j.error || 'HTTP ' + r.status);
        err.status = r.status;
        err.body = j;
        throw err;
      }
      return j;
    } catch (e) {
      if (e && e.name === 'AbortError') {
        const err = new Error('Request timed out. Please try again.');
        err.timeout = true;
        throw err;
      }
      throw e;
    } finally {
      if (timeoutId) clearTimeout(timeoutId);
    }
  },
  async get(p) {
    const controller = typeof AbortController !== 'undefined' ? new AbortController() : null;
    const timeoutId = controller ? setTimeout(() => controller.abort(), 25000) : null;
    try {
      const sep = p.indexOf('?') >= 0 ? '&' : '?';
      const r = await fetch(p + sep + 'token=' + encodeURIComponent(state.token || ''), {
        headers: { 'Accept': 'application/json' },
        signal: controller ? controller.signal : undefined
      });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) {
        if (r.status === 401) { state.token = null; state.user = null; saveAuth(); state.stage = 'start'; render(); }
        const err = new Error(j.error || 'HTTP ' + r.status);
        err.status = r.status;
        err.body = j;
        throw err;
      }
      return j;
    } catch (e) {
      if (e && e.name === 'AbortError') {
        const err = new Error('Request timed out. Please try again.');
        err.timeout = true;
        throw err;
      }
      throw e;
    } finally {
      if (timeoutId) clearTimeout(timeoutId);
    }
  }
};

/* Progress writes are best-effort from the screen; the authoritative blueprint and delivery
   writes also happen server-side in their own endpoints. A temporary database outage must not
   interrupt an active voice turn. */
function trackLeadProgress(status, extra) {
  if (!state.token) return Promise.resolve(null);
  return api.post('/api/lead/progress', Object.assign({ status }, extra || {}))
    .catch(e => { console.warn('[lead-progress]', e.message); return null; });
}
/* Public config: scheduler link, Turnstile site key, demo mode — fetched once on boot */
function fetchConfig() {
  fetch('/api/config', { method: 'GET', headers: { 'Accept': 'application/json' } })
    .then(r => r.json()).then(j => {
      if (!j) return;
      let needsRender = false;
      if (j.schedulerLink) {
        const link = String(j.schedulerLink).trim();
        if (link && link !== state.schedulerLink) { state.schedulerLink = link; needsRender = true; }
      }
      if (j.turnstileSiteKey) {
        const key = String(j.turnstileSiteKey).trim();
        if (key && key !== state.turnstileSiteKey) { state.turnstileSiteKey = key; needsRender = true; }
      } else {
        if (state.turnstileSiteKey) { state.turnstileSiteKey = null; needsRender = true; }
      }
      const demo = !!j.demoMode;
      if (demo !== state.demoMode) { state.demoMode = demo; needsRender = true; }
      if (j.privacyPolicyUrl) {
        const purl = String(j.privacyPolicyUrl).trim();
        if (purl && purl !== state.privacyPolicyUrl) { state.privacyPolicyUrl = purl; needsRender = true; }
      } else {
        if (state.privacyPolicyUrl) { state.privacyPolicyUrl = null; needsRender = true; }
      }
      if (j.consentVersion) {
        const cv = String(j.consentVersion).trim();
        if (cv && cv !== state.consentVersion) { state.consentVersion = cv; needsRender = true; }
      }
      if (needsRender) render();
    }).catch(() => {});
}
function fetchSchedulerLink() { return fetchConfig(); }

/* ---------------- toast ---------------- */
let toastTimer = null;
/* The message is always escaped, never trusted. */
function toast(msg, isErr) {
  const t = $('#toast');
  t.innerHTML = '<span class="toast-txt">' + esc(msg) + '</span>';
  t.className = 'toast show' + (isErr ? ' err' : '');
  t.setAttribute('role', isErr ? 'alert' : 'status');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { t.className = 'toast'; }, 3800);
}

/* ---------------- voice engine (step-by-step discovery call) ----------------
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
 *   window.__PS_VOICE_TIMING__ = { silenceMs, noSpeechMs, maxListenMs, recognitionRestartMs, maxRapidRecognitionRestarts }
 */
const TIMING = Object.assign({
  silenceMs: 1200,       // quiet for about 1.2s after speech -> the answer is done
  noSpeechMs: 9000,      // nothing at all -> retry, then use typing after a second empty result
  maxListenMs: 25000,    // hard stop for one answer
  recognitionRestartMs: 250,
  recognitionRestartWindowMs: 8000,
  maxRapidRecognitionRestarts: 5,
  emptyRetryMs: 250,
  speakFactorMs: 330,    // ms per word, used to size the spoken-line watchdog
  minSpeakMs: 900,
  maxSpeakMs: 30000,
  levelThreshold: 0.02   // mic level that counts as speech (MediaRecorder engine)
}, window.__PS_VOICE_TIMING__ || {});

/* WebRTC configuration for the live call. A public STUN server is included so the browser can
   gather a server-reflexive candidate as well as a host candidate: with host candidates only (the
   previous behaviour) a visitor behind a symmetric NAT, on a mobile network or inside a corporate
   firewall can fail the handshake even though OpenAI is perfectly reachable. This changes nothing
   about the architecture - media still flows browser <-> OpenAI over the same peer connection, no
   WebSocket is involved, and no key material is in this file. */
const ICE_SERVERS = {
  iceServers: [
    { urls: 'stun:stun.l.google.com:19302' },
    { urls: 'stun:stun1.l.google.com:19302' }
  ]
};
/* Connection health timings. `graceMs` is how long a 'disconnected' state is given to recover on
   its own (a mobile handover, a wifi blip) before the call falls back - a temporary hiccup must not
   end a call. `channelOpenMs` bounds how long the handshake may take after the SDP answer is
   applied, so a session that never comes up falls back instead of hanging on "Connecting...". */
const RT_HEALTH = Object.assign({
  graceMs: 6000,
  channelOpenMs: 10000,
  pollMs: 60,
  idleMin: 5            // default; the server's idle_min wins when the session opens
}, window.__PS_RT_HEALTH__ || {});
/* The orb waveform is driven by the visitor's real microphone level while a live call is up. */
const LEVEL = Object.assign({ fftSize: 512, minBar: 3, maxBar: 22, floor: 0.012, ceiling: 0.28, smooth: 0.55 }, window.__PS_MIC_LEVEL__ || {});

/* The continuous call has its own status wording: there is no button to press and no turn to wait
   for, so the screen must not imply one. */
const RT_STATUS_TEXT = {
  idle: 'Live call. Speak whenever you are ready.',
  connecting: 'Connecting the live voice call...',
  thinking: 'Saving what you just said...',
  speaking: 'Nova is speaking. Interrupt at any time.',
  listening: 'You are speaking. Take your time, there is nothing to press.',
  ready: 'Live call. Speak whenever you are ready, or interrupt Nova.',
  complete: 'That is the call. Review what we captured, then structure the answers.',
  error: 'The live call hit a problem. It carries on step by step below.'
};

const VOICE_STATUS_TEXT = {
  idle: 'Ready when you are. Start the call and answer out loud, like a phone call.',
  connecting: 'Connecting Nova, your AI interviewer...',
  thinking: 'Thinking about what you said...',
  speaking: 'Nova is speaking. Tap Stop to interrupt.',
  listening: 'Listening. Answer in your own words, then pause when you are done.',
  ready: 'Your turn. Answer out loud when you are ready, or type instead.',
  complete: 'That is the call. Review what we captured, then structure the answers.',
  error: 'The call hit a problem. You can retry the turn, or carry on by typing.'
};

function newVoiceState() {
  return {
    cfg: null, plan: [], provider: null, mode: null, why: '',
    status: 'idle', transcript: [], asked: [], probes: {}, captures: [],
    callId: 'call-' + Math.random().toString(36).slice(2, 10), callTicket: null, turns: 0,
    startedAt: null, endedAt: null, currentQuestionId: null, pendingQuestionId: null,
    lastLine: '', interim: '', lastHeard: '', error: null, notice: null, rtNotice: null,
    micBlocked: false, micMuted: false, engine: null, handsFree: true, muted: false, typed: false,
    typedFallback: false, consecutiveEmptyTranscriptions: 0, listenGeneration: 0, listenPending: false,
    speaking: false, listening: false, capture: null, done: false, warnings: [],
    audioEl: null, stopListening: null, finishListening: null, rec: null, skipped: [], stopSpeakHook: null,
    opening: null, prefetching: false, prefetchTried: false, prefetchPromise: null,
    sessionPromise: null, sessionError: null, blockedAudio: null, retryArmed: false,
    rt: null, rtTried: false, rtFallback: false, fallbackReason: null,
    fallbackLoggedReasons: [], fallbackReportedReasons: []
  };
}

function voiceSync() { return state.voice || (state.voice = newVoiceState()); }

const VOICE_FALLBACK_COPY = {
  'no-key': 'No OpenAI API key is configured, so this call is using browser voice.',
  'token-secret-invalid': 'Live voice is disabled because PS_TOKEN_SECRET is missing, too short, or still the development secret.',
  'handshake-timeout': 'The live voice handshake timed out; the call carries on step by step, with everything you said kept.',
  'model-refused': 'This OpenAI account refused the realtime model; the call carries on step by step, with everything you said kept.',
  'webrtc-unsupported': 'This browser does not support WebRTC; the call carries on step by step, with everything you said kept.',
  'mic-blocked': 'Microphone access was blocked; you can type answers or allow microphone access to try voice again.',
  'connection-failed': 'The live voice connection failed; it carries on step by step, with everything you said kept.',
  'session-limit': 'A live voice session is temporarily unavailable; the call carries on step by step, with everything you said kept.',
  'empty-transcription': 'I could not make out two answers, so I am switching to typed answers.'
};
const VOICE_FALLBACK_CODES = Object.keys(VOICE_FALLBACK_COPY);
function isVoiceDiagnosticsVisible() {
  const host = String((window.location && window.location.hostname) || '').toLowerCase();
  return !!state.demoMode || host === 'localhost' || host === '127.0.0.1' || host === '::1' || host.endsWith('.e2b.app');
}
function canonicalVoiceFallback(reason) {
  const code = String(reason || '').trim().toLowerCase();
  return VOICE_FALLBACK_CODES.indexOf(code) >= 0 ? code : 'connection-failed';
}
function normalizeVoiceFallback(reason) {
  const code = String(reason || '').trim().toLowerCase();
  return VOICE_FALLBACK_CODES.indexOf(code) >= 0 ? code : null;
}
/* Record each distinct cause once per call. Browser-only causes are reported to the shared server
   route; connect/readiness refusals already logged by the server are marked serverReported. */
function recordVoiceFallback(reason, opts) {
  opts = opts || {};
  const v = voiceSync();
  const code = canonicalVoiceFallback(reason);
  v.fallbackReason = code; // latest fallback cause in lead metadata; server logs retain every distinct cause
  if (!v.fallbackLoggedReasons.includes(code)) {
    v.fallbackLoggedReasons.push(code);
    console.warn('[voice] fallback reason=' + code);
  }
  if (opts.reportToServer && !opts.serverReported && !v.fallbackReportedReasons.includes(code)) {
    v.fallbackReportedReasons.push(code);
    api.post('/api/voice/fallback', { call_id: v.callId, reason: code }).catch(() => {});
  }
  if (opts.showNotice !== false) {
    // Detailed fallback explanations are diagnostics; the exact mode remains visible in the badge.
    v.rtNotice = isVoiceDiagnosticsVisible() ? VOICE_FALLBACK_COPY[code] : '';
  }
  return code;
}

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
  const consentAt = new Date().toISOString();
  const consentVersion = state.consentVersion || 'v1-2026-09-28';
  state.consent = { at: consentAt, version: consentVersion, privacyPolicyUrl: state.privacyPolicyUrl || null };
  try { localStorage.setItem('ps_consent', JSON.stringify(state.consent)); } catch (e) {}
  state.stage = 'intake';
  render();
  trackLeadProgress('discovery_started', { consent_at: consentAt, consent_version: consentVersion, privacy_policy_url: state.privacyPolicyUrl || null });
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
/* Prefer a feminine browser voice for Nova: professional, and matches the marin live
   voice. Falls back to the best locale match, then to the browser default. */
function pickBrowserVoice(sy, locale) {
  try {
    const voices = sy && sy.getVoices ? sy.getVoices() : [];
    if (!voices.length) return null;
    const loc = String(locale || 'en-PH').toLowerCase();
    const base = loc.split('-')[0];
    const FEMALE = ['female', 'woman', 'samantha', 'zira', 'aria', 'jenny', 'susan',
      'karen', 'moira', 'tessa', 'fiona', 'veena', 'rishi', 'heera'];
    const score = v => {
      const name = String(v.name || '').toLowerCase();
      const lang = String(v.lang || '').toLowerCase();
      let s = 0;
      if (FEMALE.some(h => name.indexOf(h) >= 0)) s += 10;
      if (lang === loc) s += 5;
      else if (lang.indexOf(base) === 0) s += 3;
      else if (lang.indexOf('en') === 0) s += 1;
      return s;
    };
    const ranked = voices.slice().sort((a, b) => score(b) - score(a));
    return score(ranked[0]) > 0 ? ranked[0] : null;
  } catch (e) { return null; }
}
function makeUtter(text) {
  const u = new window.SpeechSynthesisUtterance(text);
  u.lang = (state.voice.cfg && state.voice.cfg.locale) || 'en-PH';
  u.rate = 1; u.pitch = 1; u.volume = 1;
  const v = pickBrowserVoice(window.speechSynthesis, u.lang);
  if (v) u.voice = v;
  return u;
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
        const u = makeUtter(text);
        u.onend = finish; u.onerror = finish;
        voiceSync().stopSpeakHook = finish;
        sy.speak(u);
        // Chrome drops the very first utterance while its voice list is still loading: retry once.
        setTimeout(() => {
          if (settled) return;
          const idle = sy.speaking === false && (sy.pending === false || sy.pending === undefined);
          if (idle) { try { sy.cancel(); sy.speak(makeUtter(text)); } catch (e) { finish(); } }
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
    v.blockedAudio = null; v.notice = null;
    playAudio(pending.b64, pending.mime)
      .then(() => { v.status = v.done ? 'complete' : 'ready'; render(); })
      .catch(() => { v.notice = 'Still blocked. Tap to play the line.'; render(); });
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
function stopListening(sendCurrent) {
  const v = voiceSync();
  // The main call UI's Stop and send action submits the current utterance. Other callers cancel
  // (switching to typing, skipping, muting, or ending the call).
  if (sendCurrent && typeof v.finishListening === 'function') {
    try { v.finishListening(); return; } catch (e) {}
  }
  v.listenGeneration = (v.listenGeneration || 0) + 1;
  v.listenPending = false;
  const cancel = v.stopListening;
  v.stopListening = null;
  v.finishListening = null;
  if (cancel) { try { cancel(); } catch (e) {} }
  else if (v.rec) {
    try { if (typeof v.rec.abort === 'function') v.rec.abort(); else v.rec.stop(); } catch (e) {}
  }
  v.rec = null;
  v.listening = false;
  v.interim = '';
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
function listenBrowser(attemptId) {
  return new Promise((resolve, reject) => {
    const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
    let rec;
    try { rec = new SR(); } catch (e) { return reject(new Error('mic-blocked')); }
    const v = voiceSync();
    v.rec = rec;
    rec.lang = (v.cfg && v.cfg.locale) || 'en-PH';
    rec.interimResults = true;
    rec.continuous = true;
    rec.maxAlternatives = 1;
    let finalText = '', interimText = '';
    let silenceTimer = null, noSpeechTimer = null, hardTimer = null, restartTimer = null;
    let settled = false;
    const restartTimes = [];
    const clear = () => {
      clearTimeout(silenceTimer); clearTimeout(noSpeechTimer); clearTimeout(hardTimer); clearTimeout(restartTimer);
      silenceTimer = noSpeechTimer = hardTimer = restartTimer = null;
    };
    const release = () => {
      clear();
      v.listening = false;
      if (v.rec === rec) v.rec = null;
      if (v.stopListening === cancel) v.stopListening = null;
      if (v.finishListening === submit) v.finishListening = null;
    };
    const transcript = () => (finalText + ' ' + interimText).replace(/\s+/g, ' ').trim();
    const finish = txt => {
      if (settled) return;
      settled = true;
      release();
      try { rec.stop(); } catch (e) {}
      resolve(String(txt || '').trim());
    };
    const cancel = () => {
      if (settled) return;
      settled = true;
      release();
      try { if (typeof rec.abort === 'function') rec.abort(); else rec.stop(); } catch (e) {}
      resolve(null);
    };
    const submit = () => finish(transcript());
    const failMic = () => {
      if (settled) return;
      settled = true;
      release();
      try { if (typeof rec.abort === 'function') rec.abort(); else rec.stop(); } catch (e) {}
      reject(new Error('mic-blocked'));
    };
    const armSilence = () => {
      clearTimeout(silenceTimer);
      silenceTimer = setTimeout(() => finish(transcript()), TIMING.silenceMs);
    };
    const scheduleRestart = () => {
      if (settled || attemptId !== v.listenGeneration || v.micMuted || restartTimer) return;
      const now = Date.now();
      const windowMs = Math.max(1, Number(TIMING.recognitionRestartWindowMs) || 8000);
      const cap = Math.max(1, Number(TIMING.maxRapidRecognitionRestarts) || 5);
      while (restartTimes.length && now - restartTimes[0] >= windowMs) restartTimes.shift();
      const baseDelay = Math.max(0, Number(TIMING.recognitionRestartMs) || 250);
      const delay = restartTimes.length >= cap
        ? Math.max(baseDelay, windowMs - (now - restartTimes[0]))
        : baseDelay;
      restartTimer = setTimeout(() => {
        restartTimer = null;
        if (settled || attemptId !== v.listenGeneration || v.micMuted) return;
        restartTimes.push(Date.now());
        try {
          rec.start();
          v.listening = true;
          v.status = 'listening';
          render();
        } catch (e) {
          if (e && (e.name === 'NotAllowedError' || /notallowed|service-not-allowed/i.test(e.message || ''))) return failMic();
          // Some engines dispatch `end` slightly before start() is legal again. Keep retrying, but
          // through the same windowed cap so an engine bug cannot spin the CPU or the event queue.
          scheduleRestart();
        }
      }, delay);
    };
    v.stopListening = cancel;
    v.finishListening = submit;
    rec.onresult = e => {
      let nextInterim = '';
      let gotSpeech = false;
      for (let i = e.resultIndex; i < e.results.length; i++) {
        const r = e.results[i];
        const word = String(r && r[0] && r[0].transcript || '').trim();
        if (!word) continue;
        gotSpeech = true;
        if (r.isFinal) finalText += word + ' ';
        else nextInterim += word;
      }
      if (gotSpeech) {
        interimText = nextInterim;
        clearTimeout(noSpeechTimer);
        v.interim = transcript();
        updateLiveLine();
        armSilence();
      }
    };
    rec.onerror = ev => {
      const code = ev && ev.error;
      if (code === 'not-allowed' || code === 'service-not-allowed' || code === 'audio-capture') return failMic();
      if (code === 'no-speech') { scheduleRestart(); return; }
      if (transcript()) finish(transcript());
      else scheduleRestart();
    };
    rec.onend = () => { if (!settled) scheduleRestart(); };
    try { rec.start(); }
    catch (e) { return failMic(); }
    v.listening = true;
    render(); // the main call UI labels the override "Stop and send" only once listening is active
    noSpeechTimer = setTimeout(() => {
      if (transcript()) finish(transcript());
      else finish('');
    }, Math.min(TIMING.noSpeechMs, TIMING.maxListenMs));
    hardTimer = setTimeout(() => finish(transcript()), TIMING.maxListenMs);
  });
}
function listenOpenAI(attemptId) {
  return new Promise((resolve, reject) => {
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia || !window.MediaRecorder) {
      return reject(new Error('mic-blocked'));
    }
    navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true } }).then(stream => {
      const v = voiceSync();
      const stopTracks = () => { try { stream.getTracks().forEach(t => t.stop()); } catch (e) {} };
      if (attemptId !== v.listenGeneration || v.micMuted || v.typed) { stopTracks(); return resolve(null); }
      const chunks = [];
      let rec, ctx = null, raf = null, stopped = false, heard = false;
      const startedAt = Date.now();
      let lastLoud = Date.now();
      const closeMeter = () => {
        try { if (raf && window.cancelAnimationFrame) window.cancelAnimationFrame(raf); else if (raf) clearTimeout(raf); } catch (e) {}
        raf = null;
        try { if (ctx) ctx.close(); } catch (e) {}
        ctx = null;
      };
      const forgetListener = () => {
        v.listening = false;
        if (v.rec === rec) v.rec = null;
        if (v.stopListening === cancel) v.stopListening = null;
        if (v.finishListening === finish) v.finishListening = null;
      };
      const cancel = () => {
        if (stopped) return;
        stopped = true;
        closeMeter();
        try { if (rec) { rec.onstop = null; rec.stop(); } } catch (e) {}
        stopTracks();
        forgetListener();
        resolve(null);
      };
      let recordingSaved = false;
      const saveRecording = async () => {
        if (recordingSaved) return;
        recordingSaved = true;
        stopTracks();
        const blob = new Blob(chunks, { type: (rec && rec.mimeType) || 'audio/webm' });
        forgetListener();
        if (!blob.size) return resolve('');
        v.status = 'thinking'; render();
        try {
          const b64 = await blobToBase64(blob);
          const j = await api.post('/api/voice/transcribe', { audio_base64: b64, mime: blob.type || 'audio/webm' });
          resolve(String(j.text || '').trim());
        } catch (e) { reject(e); }
      };
      const finish = () => {
        if (stopped) return;
        stopped = true;
        closeMeter();
        // MediaRecorder emits its final dataavailable event before stop. Wait for onstop so the
        // server transcription receives the complete recording, not an empty pre-stop snapshot.
        if (!rec || rec.state === 'inactive') return saveRecording();
        try {
          rec.onstop = () => { saveRecording(); };
          rec.stop();
        } catch (e) { saveRecording(); }
      };
      try {
        rec = new MediaRecorder(stream);
        rec.ondataavailable = e => { if (e.data && e.data.size) chunks.push(e.data); };
        rec.start();
        v.rec = rec;
        v.stopListening = cancel;
        v.finishListening = finish;
        v.listening = true;
        render(); // keep the main call UI's stop/send control in sync with the live recorder
        const AC = window.AudioContext || window.webkitAudioContext;
        if (AC) {
          try {
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
              if (heard && Date.now() - lastLoud >= TIMING.silenceMs) return finish();
              if (!heard && Date.now() - startedAt >= TIMING.noSpeechMs) return finish();
              if (Date.now() - startedAt >= TIMING.maxListenMs) return finish();
              raf = window.requestAnimationFrame ? window.requestAnimationFrame(tick) : setTimeout(tick, 120);
            };
            tick();
          } catch (e) {
            closeMeter();
            setTimeout(finish, TIMING.maxListenMs);
          }
        } else {
          setTimeout(finish, TIMING.maxListenMs);
        }
      } catch (e) {
        closeMeter(); stopTracks();
        forgetListener();
        reject(e);
      }
    }).catch(e => {
      if (attemptId !== voiceSync().listenGeneration) return resolve(null);
      reject(new Error(e && e.name === 'NotAllowedError' ? 'mic-blocked' : 'mic-blocked'));
    });
  });
}
function switchToTypedFallback(reason, message) {
  const v = voiceSync();
  const code = recordVoiceFallback(reason, { reportToServer: true, showNotice: false });
  const diagnostics = isVoiceDiagnosticsVisible();
  setFallbackNotice(diagnostics ? (VOICE_FALLBACK_COPY[code] || String(message || '')) : '');
  v.micBlocked = true;
  v.micMuted = true;
  v.typed = true;
  v.typedFallback = true;
  v.listening = false;
  v.interim = '';
  v.status = 'ready';
  v.notice = 'Typing is on. Type your answer below to continue.';
  render();
}
async function listenForAnswer() {
  const v = voiceSync();
  if (v.done || v.typed || v.micMuted || v.listenPending) return;
  const attemptId = (v.listenGeneration || 0) + 1;
  v.listenGeneration = attemptId;
  v.listenPending = true;
  const engine = pickEngine();
  v.engine = engine;
  if (!engine) {
    v.listenPending = false;
    switchToTypedFallback('mic-blocked', 'No microphone is available in this browser. Type your answers below, or open this page in a browser with microphone support.');
    return;
  }
  v.status = 'listening'; v.interim = ''; v.notice = null; v.error = null;
  render();
  let text = '';
  try {
    text = engine === 'browser' ? await listenBrowser(attemptId) : await listenOpenAI(attemptId);
  } catch (e) {
    if (attemptId !== v.listenGeneration) return;
    v.listenPending = false;
    v.listening = false;
    if (e && e.message === 'mic-blocked') {
      switchToTypedFallback('mic-blocked', 'The microphone is blocked here. Type your answers below, or open the site in its own tab and allow microphone access.');
      return;
    }
    const code = recordVoiceFallback('connection-failed', { reportToServer: true, showNotice: false });
    setFallbackNotice(isVoiceDiagnosticsVisible() ? VOICE_FALLBACK_COPY[code] : '');
    v.micBlocked = true; v.micMuted = true; v.typed = true; v.typedFallback = true;
    v.status = 'ready'; v.error = null;
    v.notice = 'Typing is on. Type your answer below to continue.';
    render();
    return;
  }
  if (attemptId !== v.listenGeneration) return;
  v.listenPending = false;
  v.listening = false;
  v.rec = null;
  v.stopListening = null;
  v.interim = '';
  if (text == null) return; // cancelled by mute, typing, hang-up, or a replacement listen
  const heard = String(text || '').trim();
  if (!heard) {
    v.consecutiveEmptyTranscriptions = (v.consecutiveEmptyTranscriptions || 0) + 1;
    if (v.consecutiveEmptyTranscriptions >= 2) {
      switchToTypedFallback('empty-transcription', 'I could not make out two answers, so I am switching to typed answers. Type below to keep going.');
      return;
    }
    v.status = 'ready';
    v.notice = 'I did not catch that. I am listening again automatically.';
    render();
    await new Promise(resolve => setTimeout(resolve, Math.max(0, TIMING.emptyRetryMs)));
    if (attemptId === v.listenGeneration && !v.micMuted && !v.typed && !v.done) await listenForAnswer();
    return;
  }
  v.consecutiveEmptyTranscriptions = 0;
  v.lastHeard = heard;
  await voiceTurn(heard);
}

/* ---------------- the continuous call (OpenAI Realtime over WebRTC) ----------------
 * One session carries the whole conversation. The microphone is opened once and stays open from the
 * first question to the last: the model hears where each answer ends (semantic turn detection) and
 * the lead can talk over it, so nothing is cut between questions and there is no button to press.
 *
 * The guardrail set still decides what counts. After each caller turn the model calls record_answer
 * for every distinct topic answered; /api/voice/realtime/tool checks each claimed value against the
 * lead's words. The server returns uncovered topics or a required missing-fact callback, not a fixed
 * question order. Ungrounded values are refused, so nothing reaches the contract that was not said.
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
    failedDetail: '', serverReported: false,
    startedAt: null, model: null, voice: null, vad: null, maxSessionMin: 15, watchdog: null,
    callTicket: null, opening: null, toolCalls: 0, accepted: 0, rejected: 0, endAttempts: 0,
    lastUserTurn: '', userLines: [], aiLines: [], handled: {}, aiPartial: '', pendingAttribution: null,
    responseActive: false, responseCreatePending: false, responseCreateTimer: null, queuedResponse: null,
    lastResponseHadSpeech: false, lastResponseAskedQuestion: false, userSpeaking: false, closing: false,
    dropped: false, micMuted: false, micCalls: 0,
    validationQueue: Promise.resolve(), pendingValidations: 0, callerFinishedAt: null, latencySamples: [],
    checkInTimer: null, skipTimer: null, silenceStage: 0, silenceGeneration: 0, pauseRequested: false,
    // connection health: what the peer connection last reported, and the grace timer that keeps a
    // temporary network hiccup from ending the call.
    connState: '', iceState: '', healthTimer: null, teardown: false, channelTimer: null,
    // real microphone level driving the orb waveform (null when the browser has no AudioContext).
    level: null,
    // inactivity: the last-resort polite wrap-up is measured from caller activity, not Nova's voice.
    idleTimer: null, lastActivityAt: 0, idleMin: RT_HEALTH.idleMin, maxToolCalls: 90,
    // the hang-up report has been sent, so the page-exit guard does not send it twice.
    endedSent: false
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
/* Realtime allows one active response at a time. Tool results can arrive in a burst, so hold one
   response request until the current response.done event rather than issuing overlapping creates. */
function rtRespond(instructions) {
  const rt = voiceSync().rt;
  if (!rt) return false;
  const request = { instructions: instructions ? String(instructions).slice(0, 1500) : '' };
  if (rt.userSpeaking || rt.responseActive || rt.responseCreatePending) {
    rt.queuedResponse = request; // coalesce same-turn tools into one next response
    return true;
  }
  const ev = { type: 'response.create' };
  if (request.instructions) ev.response = { instructions: request.instructions };
  const sent = rtSend(ev);
  if (sent) {
    rt.responseCreatePending = true;
    if (rt.responseCreateTimer) clearTimeout(rt.responseCreateTimer);
    rt.responseCreateTimer = setTimeout(() => {
      rt.responseCreateTimer = null;
      if (rt.responseCreatePending && !rt.responseActive) {
        rt.responseCreatePending = false;
        flushRealtimeResponse();
      }
    }, 5000);
  }
  return sent;
}
function flushRealtimeResponse() {
  const rt = voiceSync().rt;
  if (!rt || !rt.queuedResponse || rt.userSpeaking || rt.responseActive || rt.responseCreatePending || rt.teardown || rt.dropped || voiceSync().done) return false;
  const queued = rt.queuedResponse;
  rt.queuedResponse = null;
  return rtRespond(queued.instructions || null);
}

/* ---------------- the visitor's real microphone level ----------------
   The orb waveform used to be a CSS animation: it moved whether or not anyone was speaking. This
   drives the same nine bars from an AnalyserNode on the SAME MediaStream the peer connection is
   already using, so there is no second permission prompt and no second microphone. Where the
   browser has no AudioContext the meter is never started and the CSS animation carries on. */
const LEVEL_WEIGHTS = [0.55, 0.8, 1, 0.7, 0.9, 1, 0.75, 0.6, 0.85];
function startMicLevel(stream) {
  const rt = voiceSync().rt;
  stopMicLevel();
  if (!stream) return;
  const AC = window.AudioContext || window.webkitAudioContext;
  if (typeof AC !== 'function') return;
  let ctx = null, analyser = null, src = null, buf = null;
  try {
    ctx = new AC();
    analyser = ctx.createAnalyser();
    analyser.fftSize = LEVEL.fftSize;
    try { analyser.smoothingTimeConstant = 0.6; } catch (e) {}
    src = ctx.createMediaStreamSource(stream);
    src.connect(analyser);
    buf = new Uint8Array(analyser.fftSize || LEVEL.fftSize);
  } catch (e) {
    // A partial or blocked AudioContext must never take the call down: fall back to the CSS wave.
    try { if (src && src.disconnect) src.disconnect(); } catch (e2) {}
    try { if (ctx && ctx.close) { const p = ctx.close(); if (p && typeof p.catch === 'function') p.catch(() => {}); } } catch (e3) {}
    rt.level = null;
    return;
  }
  // The call starts inside a click, so a context that begins suspended is resumed here.
  try {
    if (ctx.state === 'suspended' && typeof ctx.resume === 'function') {
      const p = ctx.resume(); if (p && typeof p.catch === 'function') p.catch(() => {});
    }
  } catch (e) {}
  rt.level = { ctx: ctx, analyser: analyser, src: src, buf: buf, raf: null, value: 0, stopped: false };
  const tick = () => {
    const lv = rt.level;
    if (!lv || lv.stopped) return;          // stopMicLevel() owns the loop's lifetime
    lv.raf = null;
    let peak = 0;
    try {
      lv.analyser.getByteTimeDomainData(lv.buf);
      for (let i = 0; i < lv.buf.length; i++) { const d = Math.abs(lv.buf[i] - 128) / 128; if (d > peak) peak = d; }
    } catch (e) { peak = 0; }
    // A muted microphone shows silence, and the value is smoothed so the bars breathe, not flicker.
    const target = rt.micMuted ? 0 : peak;
    lv.value += (target - lv.value) * (target > lv.value ? 0.6 : LEVEL.smooth);
    paintMicLevel(lv.value);
    lv.raf = window.requestAnimationFrame ? window.requestAnimationFrame(tick) : setTimeout(tick, 60);
  };
  tick();
}
function stopMicLevel() {
  const rt = voiceSync().rt;
  const lv = rt && rt.level;
  if (!lv) return;
  lv.stopped = true;                        // ends the loop even if a frame is already queued
  try {
    if (lv.raf != null) {
      if (window.cancelAnimationFrame) window.cancelAnimationFrame(lv.raf);
      clearTimeout(lv.raf);
    }
  } catch (e) {}
  lv.raf = null;
  try { if (lv.src && lv.src.disconnect) lv.src.disconnect(); } catch (e) {}
  try { if (lv.analyser && lv.analyser.disconnect) lv.analyser.disconnect(); } catch (e) {}
  try {
    if (lv.ctx && typeof lv.ctx.close === 'function') {
      const p = lv.ctx.close(); if (p && typeof p.catch === 'function') p.catch(() => {});
    }
  } catch (e) {}
  rt.level = null;
  clearMicLevelBars();
}
/* render() rebuilds the orb, so the bars are re-queried each frame instead of cached; a missing orb
   (the visitor has left the call screen) simply paints nothing. */
function paintMicLevel(v) {
  const wave = document.querySelector('#orb .wave');
  if (!wave) return;
  // Hand the bars back from the CSS keyframes: an animation outranks an inline height.
  if (wave.className.indexOf('level') < 0) wave.className += ' level';
  const bars = wave.children;
  const norm = Math.max(0, Math.min(1, (v - LEVEL.floor) / (LEVEL.ceiling - LEVEL.floor)));
  const opacity = (0.45 + 0.55 * Math.min(1, norm * 1.4)).toFixed(2);
  for (let i = 0; i < bars.length; i++) {
    const w = LEVEL_WEIGHTS[i % LEVEL_WEIGHTS.length];
    const h = LEVEL.minBar + (LEVEL.maxBar - LEVEL.minBar) * Math.min(1, norm * w * (0.75 + 0.5 * Math.random()));
    try { bars[i].style.height = h.toFixed(1) + 'px'; bars[i].style.opacity = opacity; } catch (e) {}
  }
}
function clearMicLevelBars() {
  const wave = document.querySelector('#orb .wave');
  if (!wave) return;
  wave.className = wave.className.replace(/\s*\blevel\b/g, '');
  for (let i = 0; i < wave.children.length; i++) {
    try { wave.children[i].style.height = ''; wave.children[i].style.opacity = ''; } catch (e) {}
  }
}

/* ---------------- WebRTC connection health ----------------
   'disconnected' gets a grace period because it usually recovers by itself (a mobile handover, a
   wifi blip), and ending a good call on the first hiccup is worse than waiting a few seconds.
   'failed' and 'closed' are terminal. Every terminal path goes through dropRealtime(), which keeps
   every answer already captured and carries the same call on step by step. */
const CONN_LABEL = {
  connected: 'connected', completed: 'connected', connecting: 'connecting', checking: 'connecting',
  new: 'opening', disconnected: 'reconnecting', failed: 'failed', closed: 'closed'
};
function armConnectionHealth(pc) {
  const rt = voiceSync().rt;
  if (!rt || !pc) return;
  const onState = () => {
    if (!rt || rt.teardown || rt.dropped || rt.closing) return;   // ignore our own teardown
    let conn = '', ice = '';
    try { conn = pc.connectionState || ''; } catch (e) {}
    try { ice = pc.iceConnectionState || ''; } catch (e) {}
    const s = conn || ice;
    if (s) { rt.connState = s; rt.iceState = ice || rt.iceState; }
    if (s === 'connected' || s === 'completed') clearHealthGrace();
    else if (s === 'failed' || s === 'closed') {
      clearHealthGrace();
      if (rt.live) dropRealtime('connection-failed', s === 'failed' ? 'The live voice connection failed.' : 'The live voice connection closed.');
      else { rt.failed = rt.failed || 'connection-failed'; rt.failedDetail = rt.failedDetail || s; }
    } else if (s === 'disconnected') armHealthGrace();
    updateConnNote();
  };
  rt.onConnState = onState;
  // addEventListener where it exists, the on* properties where it does not, as waitForIce() does.
  try { pc.addEventListener('connectionstatechange', onState); }
  catch (e) { try { pc.onconnectionstatechange = onState; } catch (e2) {} }
  try { pc.addEventListener('iceconnectionstatechange', onState); }
  catch (e) { try { pc.oniceconnectionstatechange = onState; } catch (e2) {} }
}
function detachConnectionHealth(pc) {
  const rt = voiceSync().rt;
  const fn = rt && rt.onConnState;
  if (rt) rt.onConnState = null;
  if (!pc || !fn) return;
  try { pc.removeEventListener('connectionstatechange', fn); } catch (e) {}
  try { pc.removeEventListener('iceconnectionstatechange', fn); } catch (e) {}
  try { pc.onconnectionstatechange = null; } catch (e) {}
  try { pc.oniceconnectionstatechange = null; } catch (e) {}
}
function armHealthGrace() {
  const rt = voiceSync().rt;
  if (!rt || rt.healthTimer) return;        // idempotent: flapping states must not extend the grace
  rt.healthTimer = setTimeout(() => {
    rt.healthTimer = null;
    if (!rt.live || rt.dropped || rt.closing || rt.teardown) return;
    let s = '';
    try { s = (rt.pc && (rt.pc.connectionState || rt.pc.iceConnectionState)) || ''; } catch (e) {}
    if (s === 'connected' || s === 'completed') { updateConnNote(); return; }
    dropRealtime('connection-failed', 'The live voice connection dropped out and did not come back.');
  }, RT_HEALTH.graceMs);
}
function clearHealthGrace() {
  const rt = voiceSync().rt;
  if (rt && rt.healthTimer) { clearTimeout(rt.healthTimer); rt.healthTimer = null; }
}
/* Connection state on screen, patched in place so a state change never rebuilds the orb. */
function updateConnNote() {
  const el = document.getElementById('conn-state');
  if (!el) return;
  const rt = voiceSync().rt;
  const s = (rt && rt.connState) || '';
  const bad = s === 'disconnected' || s === 'failed' || s === 'closed';
  el.textContent = 'Connection: ' + (s ? (CONN_LABEL[s] || s) : 'opening');
  el.className = 'conn-state' + (bad ? ' bad' : '');
}

/* Inactivity is measured from caller activity, not Nova’s check-ins or audio output. This keeps
   the existing idle wrap-up as a last resort after the 8s/20s courtesy prompts, without allowing
   those prompts themselves to postpone it forever. The server still enforces its own hard limit. */
function armIdleWatchdog() {
  const v = voiceSync(); const rt = v.rt;
  if (!rt || rt.idleTimer) return;
  const mins = Math.max(1, rt.idleMin || RT_HEALTH.idleMin);
  rt.lastActivityAt = rt.lastActivityAt || Date.now();
  rt.idleTimer = setInterval(() => {
    if (!rt.live || v.done || rt.closing || rt.teardown || rt.dropped) return;
    if (Date.now() - (rt.lastActivityAt || Date.now()) < mins * 60 * 1000) return;
    rt.lastActivityAt = Date.now();         // one wrap-up attempt per idle window
    rt.closing = true;
    v.notice = 'It has been quiet for a while, so let us wrap up. Everything we captured is on the next screen.';
    rtRespond('It has been quiet for a while. Thank them, tell them the next step is to review and correct what we captured on screen, and that a human reviews the blueprint. Then call end_call.');
    setTimeout(() => { if (!v.done) finishCall(); }, 30000);
    render();
  }, 20000);
}
function clearIdleWatchdog() {
  const rt = voiceSync().rt;
  if (rt && rt.idleTimer) { clearInterval(rt.idleTimer); rt.idleTimer = null; }
}
function touchActivity() {
  const rt = voiceSync().rt;
  if (rt) rt.lastActivityAt = Date.now();
}
function realtimeSilenceTiming() {
  const test = window.__PS_REALTIME_SILENCE_TIMING__ || {};
  const check = Number(test.checkInMs);
  const offer = Number(test.skipMs);
  const checkInMs = Number.isFinite(check) && check > 0 ? check : 8000;
  const skipMs = Number.isFinite(offer) && offer > checkInMs ? offer : 20000;
  return { checkInMs, skipMs };
}
function clearRealtimeSilenceTimers(resetStage) {
  const rt = voiceSync().rt;
  if (!rt) return;
  if (rt.checkInTimer) clearTimeout(rt.checkInTimer);
  if (rt.skipTimer) clearTimeout(rt.skipTimer);
  rt.checkInTimer = null; rt.skipTimer = null;
  rt.silenceGeneration++;
  if (resetStage) rt.silenceStage = 0;
}
function armRealtimeSilenceCheckIns() {
  const v = voiceSync(); const rt = v.rt;
  if (!rt || !rt.live || v.done || rt.closing || rt.teardown || rt.dropped || rt.userSpeaking || rt.pauseRequested) return;
  clearRealtimeSilenceTimers(false);
  rt.silenceStage = 0;
  const generation = rt.silenceGeneration;
  const timing = realtimeSilenceTiming();
  const stillQuiet = () => rt.silenceGeneration === generation && rt.live && !v.done && !rt.closing &&
    !rt.teardown && !rt.dropped && !rt.userSpeaking && !rt.pauseRequested;
  rt.checkInTimer = setTimeout(() => {
    rt.checkInTimer = null;
    if (!stillQuiet()) return;
    rt.silenceStage = 1;
    rtRespond('Say only “Take your time.” Then stop and wait. Do not ask a question or call a tool.');
  }, timing.checkInMs);
  rt.skipTimer = setTimeout(() => {
    rt.skipTimer = null;
    if (!stillQuiet()) return;
    rt.silenceStage = 2;
    rtRespond('Gently say, “No rush. Would you like to skip this one?” Then stop and wait. Do not call a tool unless the caller answers.');
  }, timing.skipMs);
}
function noteRealtimeSpeechStart() {
  const v = voiceSync();
  const rt = v.rt;
  if (!rt || !Number.isFinite(rt.callerFinishedAt)) return;
  const elapsed = Math.max(0, Date.now() - rt.callerFinishedAt);
  rt.callerFinishedAt = null;
  // Keep one sample for every completed caller-to-Nova hand-off; only the aggregate is persisted.
  if (!Array.isArray(rt.latencySamples)) rt.latencySamples = [];
  rt.latencySamples.push(elapsed);
  const message = '[voice] realtime caller-finish-to-nova-start_ms=' + elapsed + ' target=<1000';
  if (v.callId) console.info(message + ' call=' + String(v.callId).slice(0, 64));
  else console.info(message);
}
function summarizeRealtimeLatency(samples) {
  const sorted = (Array.isArray(samples) ? samples : [])
    .filter(value => Number.isFinite(value) && value >= 0)
    .map(Math.round)
    .sort((a, b) => a - b);
  if (!sorted.length) return { median_ms: null, p90_ms: null, turns_measured: 0 };
  const mid = Math.floor(sorted.length / 2);
  const median = sorted.length % 2 ? sorted[mid] : Math.round((sorted[mid - 1] + sorted[mid]) / 2);
  // Nearest-rank percentile: p90 is the first observed value at or above the 90th percentile.
  const p90 = sorted[Math.max(0, Math.ceil(sorted.length * 0.9) - 1)];
  return { median_ms: median, p90_ms: p90, turns_measured: sorted.length };
}
function addRealtimeSystemNote(text) {
  const note = String(text || '').trim().slice(0, 1600);
  if (!note) return false;
  return rtSend({
    type: 'conversation.item.create',
    item: { type: 'message', role: 'system', content: [{ type: 'input_text', text: note }] }
  });
}

/* Bound the handshake: if the event channel never opens, the session is not usable and the call
   must fall back rather than sit on "Connecting..." forever. */
function waitForDataChannel(dc, ms) {
  return new Promise(resolve => {
    if (!dc) return resolve(false);
    if (dc.readyState === 'open') return resolve(true);
    const limit = Date.now() + (ms || RT_HEALTH.channelOpenMs);
    const poll = () => {
      if (!dc) return resolve(false);
      if (dc.readyState === 'open') return resolve(true);
      if (dc.readyState === 'closed' || dc.readyState === 'closing') return resolve(false);
      if (Date.now() > limit) return resolve(false);
      setTimeout(poll, RT_HEALTH.pollMs);
    };
    poll();
  });
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
function clientRealtimeFailure(err) {
  if (err && err.body && err.body.fallback_reason) return canonicalVoiceFallback(err.body.fallback_reason);
  if (err && (err.timeout || err.name === 'AbortError') || /timeout|timed out|aborted/i.test(String(err && err.message || ''))) return 'handshake-timeout';
  const text = String(err && (err.message || err.error) || '').toLowerCase();
  if (/model|voice|realtime.{0,40}(access|available|supported)|not found|does not exist/.test(text) && !/invalid_api_key|incorrect api key/.test(text)) return 'model-refused';
  return 'connection-failed';
}
async function startRealtimeCall() {
  const v = voiceSync();
  const rt = rtSync();
  if (rt.live) return true;
  rt.teardown = false; rt.endedSent = false; rt.connState = ''; rt.dropped = false;
  rt.failed = null; rt.failedDetail = ''; rt.serverReported = false;
  try { await ensureSession(); }
  catch (e) { rt.failed = clientRealtimeFailure(e); rt.failedDetail = e.message || ''; return false; }
  const planned = !!(v.cfg && v.cfg.realtime && v.cfg.realtime.enabled);
  if (!planned) {
    const configuredReason = v.cfg && v.cfg.realtime && v.cfg.realtime.fallback_reason;
    rt.failed = configuredReason ? canonicalVoiceFallback(configuredReason) : 'realtime-disabled';
    return false; // a disabled switch is intentional, not a failed live call
  }
  if (typeof window.RTCPeerConnection !== 'function') {
    rt.failed = 'webrtc-unsupported';
    return false;
  }
  if (!navigator.mediaDevices || typeof navigator.mediaDevices.getUserMedia !== 'function') {
    rt.failed = 'mic-blocked';
    return false;
  }
  v.engine = 'realtime';
  v.status = 'connecting'; v.error = null; render();
  rt.connecting = true;
  let mic = null;
  try {
    mic = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true } });
    rt.micCalls++;
  } catch (e) {
    rt.connecting = false; rt.failed = 'mic-blocked'; rt.failedDetail = e && e.message || '';
    return false;   // the call carries on with the step-by-step interviewer and typed answers
  }
  rt.mic = mic;
  // The orb waveform reacts to the visitor's actual voice, on this same stream: no second
  // getUserMedia, so no second permission prompt.
  startMicLevel(mic);
  let pc = null;
  // A public STUN server gives the browser a server-reflexive candidate as well as a host one, so
  // NAT, mobile and corporate networks can complete the handshake. If a browser rejects the config
  // object at all, fall back to the unconfigured peer connection rather than losing the call.
  try { pc = new RTCPeerConnection(ICE_SERVERS); }
  catch (e) { try { pc = new RTCPeerConnection(); } catch (e2) { cleanupRealtime(); rt.failed = 'webrtc-unsupported'; rt.failedDetail = e2.message || ''; return false; } }
  if (!pc) { cleanupRealtime(); rt.failed = 'webrtc-unsupported'; return false; }
  rt.pc = pc;
  armConnectionHealth(pc);
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
  try { dc = pc.createDataChannel('oai-events'); } catch (e) { cleanupRealtime(); rt.failed = 'connection-failed'; rt.failedDetail = e.message || ''; return false; }
  rt.dc = dc;
  dc.onopen = () => {
    rt.live = true; rt.connecting = false; rt.dropped = false;
    v.status = 'speaking'; v.speaking = true;
    v.startedAt = v.startedAt || new Date().toISOString();
    rt.startedAt = v.startedAt;
    if (rt.opening && rt.opening.question_id) v.currentQuestionId = rt.opening.question_id;
    render();
    armSessionWatchdog();
    touchActivity(); armIdleWatchdog();
    // The opening question was picked by the guardrail set on the server: ask the session to say it.
    rtRespond(rt.opening && rt.opening.instruction
      ? rt.opening.instruction + (rt.opening.ask_now ? ' Start with: "' + rt.opening.ask_now + '"' : '')
      : null);
  };
  dc.onmessage = e => handleRealtimeEvent(e && e.data);
  dc.onclose = () => { if (rt.live && !v.done && !rt.closing) dropRealtime('connection-failed', 'The live voice session closed.'); };
  dc.onerror = () => { if (!rt.live) { rt.connecting = false; cleanupRealtime(); rt.failed = rt.failed || 'connection-failed'; } };
  let offer = null;
  try {
    offer = await pc.createOffer();
    await pc.setLocalDescription(offer);
    await waitForIce(pc, 4000);
  } catch (e) { cleanupRealtime(); rt.failed = 'connection-failed'; rt.failedDetail = e.message || ''; return false; }
  const sdp = (pc.localDescription && pc.localDescription.sdp) || (offer && offer.sdp) || '';
  let res = null;
  try {
    res = await api.post('/api/voice/realtime/connect', {
      call_id: v.callId, sdp, client_name: (state.user && state.user.name) || '',
      answers: answersForUpload(), asked: v.asked, skipped: v.skipped, voice_captures: v.captures
    });
  } catch (e) {
    cleanupRealtime();
    rt.failed = clientRealtimeFailure(e);
    rt.failedDetail = e.message || '';
    rt.serverReported = !!(e.body && e.body.fallback_reason);
    return false;
  }
  if (!res || !res.ok || !res.sdp) {
    cleanupRealtime();
    rt.failed = res && res.fallback_reason ? canonicalVoiceFallback(res.fallback_reason) : clientRealtimeFailure(res || {});
    rt.failedDetail = (res && res.error) || '';
    rt.serverReported = !!(res && res.fallback_reason);
    return false;
  }
  rt.callTicket = res.call_ticket || null;
  rt.opening = res.opening || null;
  rt.model = res.model || null; rt.voice = res.voice || null; rt.vad = res.turn_detection || null;
  rt.maxSessionMin = res.max_session_min || 15;
  rt.maxToolCalls = res.max_tool_calls || rt.maxToolCalls || 90;
  rt.idleMin = res.idle_min || RT_HEALTH.idleMin;
  v.provider = res.provider || 'openai-realtime';
  v.mode = 'realtime';
  if (res.warnings && res.warnings.length) v.warnings = (v.warnings || []).concat(res.warnings);
  try { await pc.setRemoteDescription({ type: 'answer', sdp: res.sdp }); }
  catch (e) { cleanupRealtime(); rt.failed = 'connection-failed'; rt.failedDetail = e.message || ''; return false; }
  /* The answer is applied, but a session that never brings the event channel up is not usable.
     Bounding the wait here is what turns "stuck on Connecting..." into the step-by-step fallback. */
  const opened = await waitForDataChannel(dc, RT_HEALTH.channelOpenMs);
  rt.connecting = false;
  if (!opened) {
    if (!rt.failed) {
      rt.failed = dc && (dc.readyState === 'closed' || dc.readyState === 'closing') ? 'connection-failed' : 'handshake-timeout';
    }
    cleanupRealtime();
    return false;
  }
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
  /* Mark the teardown first: closing the peer connection fires connection/ICE state changes, and
     those must not be mistaken for a network failure and trigger a second fallback. */
  rt.teardown = true;
  clearHealthGrace();
  clearIdleWatchdog();
  clearRealtimeSilenceTimers(true);
  if (rt.responseCreateTimer) { clearTimeout(rt.responseCreateTimer); rt.responseCreateTimer = null; }
  rt.responseCreatePending = false; rt.queuedResponse = null;
  if (rt.watchdog) { clearTimeout(rt.watchdog); rt.watchdog = null; }
  detachConnectionHealth(rt.pc);
  stopMicLevel();                       // closes the AudioContext and the analyser, not the mic track
  try { if (rt.dc) rt.dc.close(); } catch (e) {}
  try { if (rt.pc) rt.pc.close(); } catch (e) {}
  try { if (rt.mic) rt.mic.getTracks().forEach(t => t.stop()); } catch (e) {}
  try { if (rt.audioEl) { rt.audioEl.pause(); rt.audioEl.srcObject = null; if (rt.audioEl.parentNode) rt.audioEl.parentNode.removeChild(rt.audioEl); } } catch (e) {}
  rt.dc = null; rt.pc = null; rt.mic = null; rt.audioEl = null;
  rt.live = false; rt.connecting = false; rt.userSpeaking = false; rt.responseActive = false;
  rt.responseCreatePending = false; rt.callerFinishedAt = null;
  v.speaking = false; v.listening = false;
}
/* A fallback notice has to survive the automatic continuation turn that follows it, and that turn
   clears v.notice. So it lives in its own field, is rendered on its own, and goes away once the
   visitor has answered something themselves. Without this the visitor was never actually told that
   their live call had dropped: the notice was wiped before it reached the screen. */
function setFallbackNotice(msg) {
  const v = voiceSync();
  v.rtNotice = String(msg || '');
}
/* The live session died mid-call: keep everything captured and carry on step by step. */
function dropRealtime(reason, detail) {
  const v = voiceSync(); const rt = v.rt;
  if (!rt || rt.dropped) return;
  rt.dropped = true; rt.live = false;
  const code = recordVoiceFallback(reason || 'connection-failed', { reportToServer: true, showNotice: false });
  cleanupRealtime();
  v.rtFallback = true;
  v.provider = 'openai'; v.mode = 'openai'; v.engine = null;
  setFallbackNotice(isVoiceDiagnosticsVisible() ? VOICE_FALLBACK_COPY[code] : '');
  if (isVoiceDiagnosticsVisible() && detail) v.warnings = (v.warnings || []).concat([String(detail).slice(0, 240)]);
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
  const callerEvent = ev.type === 'input_audio_buffer.speech_started' ||
    ev.type === 'input_audio_buffer.speech_stopped' ||
    ev.type === 'conversation.item.input_audio_transcription.delta' ||
    ev.type === 'conversation.item.input_audio_transcription.completed';
  if (callerEvent) touchActivity(); // assistant check-ins do not reset the last-resort idle timer
  switch (ev.type) {
    case 'session.created':
    case 'session.updated': {
      const sess = ev.session || {};
      if (sess.model) rt.model = sess.model;
      break;
    }
    case 'input_audio_buffer.speech_started':
      rt.userSpeaking = true; rt.callerFinishedAt = null;
      clearRealtimeSilenceTimers(true);
      rt.queuedResponse = null;
      // Stop local WebRTC playback immediately. With semantic_vad and interrupt_response=true,
      // OpenAI cancels the response and truncates unplayed audio server-side for this WebRTC session;
      // a client conversation.item.truncate is only needed when the client owns WebSocket playback.
      try { if (rt.audioEl) rt.audioEl.muted = true; } catch (e) {}
      v.status = 'listening'; v.speaking = false; v.interim = ''; rt.aiPartial = '';
      updateLiveLine(); render();
      break;
    case 'input_audio_buffer.speech_stopped':
      rt.userSpeaking = false;
      rt.callerFinishedAt = Date.now();
      try { if (rt.audioEl) rt.audioEl.muted = !!v.muted; } catch (e) {}
      v.status = 'thinking'; render();
      break;
    case 'conversation.item.input_audio_transcription.delta':
      if (ev.transcript) { v.interim = String(ev.transcript); updateLiveLine(); }
      break;
    case 'conversation.item.input_audio_transcription.completed':
      onRealtimeUserTurn(ev.transcript || '');
      break;
    case 'response.created':
      rt.responseActive = true; rt.responseCreatePending = false;
      if (rt.responseCreateTimer) { clearTimeout(rt.responseCreateTimer); rt.responseCreateTimer = null; }
      rt.lastResponseHadSpeech = false; rt.lastResponseAskedQuestion = false;
      rt.aiPartial = ''; v.status = 'speaking'; v.speaking = true; render();
      break;
    case 'response.output_audio.delta':
      if (ev.delta) { rt.lastResponseHadSpeech = true; noteRealtimeSpeechStart(); }
      break;
    case 'response.output_audio_transcript.delta':
      if (ev.delta) {
        rt.lastResponseHadSpeech = true;
        rt.aiPartial += String(ev.delta); v.lastLine = rt.aiPartial; updateAiLine();
      }
      break;
    case 'response.output_audio_transcript.done': {
      const transcript = String(ev.transcript || rt.aiPartial || '');
      if (transcript.trim()) {
        rt.lastResponseHadSpeech = true;
        rt.lastResponseAskedQuestion = /[?？]/.test(transcript);
      }
      onRealtimeAiLine(transcript);
      break;
    }
    case 'response.function_call_arguments.done':
      onRealtimeTool(ev.call_id || ev.item_id, ev.name, ev.arguments);
      break;
    case 'response.output_item.done':
      if (ev.item && ev.item.type === 'function_call') onRealtimeTool(ev.item.call_id || ev.item.id, ev.item.name, ev.item.arguments);
      break;
    case 'response.done': {
      rt.responseActive = false; rt.responseCreatePending = false; v.speaking = false;
      if (rt.responseCreateTimer) { clearTimeout(rt.responseCreateTimer); rt.responseCreateTimer = null; }
      const r = ev.response || {};
      const detail = (r.status_details && (r.status_details.reason || r.status_details.type)) || '';
      if (r.status === 'failed' || (r.status === 'incomplete' && detail && detail !== 'interrupted')) {
        v.warnings = (v.warnings || []).concat(['The live model cut a reply short (' + (detail || r.status) + ').']);
      }
      if (rt.closing && !v.done) {
        if (rt.queuedResponse && !rt.userSpeaking) flushRealtimeResponse();
        else if (rt.responseCreatePending) v.status = 'speaking';
        else {
          v.done = true; v.endedAt = new Date().toISOString(); v.status = 'complete';
          rt.queuedResponse = null; clearRealtimeSilenceTimers(true);
        }
      } else if (!v.done) {
        v.status = rt.userSpeaking ? 'listening' : 'ready';
        if (rt.queuedResponse && !rt.userSpeaking) flushRealtimeResponse();
        else if (rt.lastResponseHadSpeech && rt.lastResponseAskedQuestion && rt.silenceStage === 0) armRealtimeSilenceCheckIns();
      }
      render();
      break;
    }
    case 'rate_limits.updated':
      break;
    case 'error': {
      const err = ev.error || {};
      const msg = String(err.message || err.code || 'The live voice session reported an error.');
      v.warnings = (v.warnings || []).concat([msg]);
      if (/session|expired|closed|not found|invalid_api_key|timeout/i.test(msg)) dropRealtime(clientRealtimeFailure(new Error(msg)), msg);
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
  // Keep a pointer only so an off-topic turn can be marked in the transcript. Do not optimistically
  // assign the words to the previously asked topic: one turn may answer several different topics,
  // and the model supplies the correct topic id for each server-validated tool call.
  rt.pendingAttribution = { qid: v.currentQuestionId, text: t };
  const pause = /\b(?:hold on|hang on|give me (?:a|one) (?:moment|second|minute)|one moment|just a (?:moment|second|minute)|bear with me|can we (?:pause|wait|hold)|come back to this|not right now)\b/i;
  const ready = /\b(?:i(?:'m| am) ready|ready now|let'?s continue|go ahead|we can continue|carry on)\b/i;
  if (pause.test(t)) rt.pauseRequested = true;
  else if (rt.pauseRequested && ready.test(t)) rt.pauseRequested = false;
  v.transcript.push({ role: 'user', text: t, questionId: v.currentQuestionId });
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
/* Realtime answers enter this array only after the server tool has accepted the call. */
function answersForUpload() { return state.answers; }
function unrecordAttribution(attr) {
  if (!attr || !attr.text) return;
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
  if (st.capture) { v.capture = st.capture; captureGen++; }
}
function quietRealtimeCaptureNote(out, job, failed) {
  const v = voiceSync();
  const plan = v.plan || [];
  const rejected = (out && Array.isArray(out.rejected)) ? out.rejected : [];
  const topics = [];
  rejected.forEach(r => {
    const field = r && r.field;
    const q = field && plan.find(x => Array.isArray(x.fields) && x.fields.indexOf(field) >= 0);
    if (q && topics.indexOf(q.label) < 0) topics.push(q.label);
  });
  const qid = (out && out.question_id) || (job && job.args && job.args.question_id);
  const current = plan.find(q => q.id === qid);
  if (out && out.answer_quality === 'off_topic' && current && topics.indexOf(current.label) < 0) topics.push(current.label);
  const stillNeeded = out && out.next && (out.next.kind === 'probe' || out.next.kind === 'callback')
    ? (out.next.still_needed || []) : [];
  const topicText = topics.length ? topics.join(', ') : (current ? current.label : 'the last topic');
  let note;
  if (failed) {
    note = 'Quiet server-save update: validation did not complete for ' + topicText + '. Do not say it was saved. Keep the conversation moving; if this topic is still uncovered, ask for it naturally later. Do not create a separate spoken turn just for this note.';
  } else if (rejected.length || (out && out.answer_quality === 'off_topic')) {
    const detail = stillNeeded.length ? ' Still needed: ' + stillNeeded.join(', ') + '.' : '';
    note = 'Quiet grounded-capture update: the server did not save the claimed value for ' + topicText + '.' + detail + ' Do not mention this check or treat the value as captured. At a natural point, ask only for the missing detail if that topic is not already answered or declined. Do not interrupt the current response or create a separate spoken turn.';
  } else if (stillNeeded.length) {
    note = 'Quiet follow-up reminder: ' + topicText + ' is still missing ' + stillNeeded.join(', ') + '. At a natural point ask one short question only for the missing detail; do not repeat anything already captured, and do not create a separate spoken turn now.';
  } else if (out && out.close === true) {
    note = 'Quiet progress update: all intake topics are covered. After your current short acknowledgement, thank the caller and close using end_call; do not ask another intake question.';
  }
  if (note) addRealtimeSystemNote(note);
}
function applyRealtimeToolResult(j, job) {
  const v = voiceSync(); const rt = v.rt;
  if (j && j.call_ticket) rt.callTicket = j.call_ticket;
  const out = (j && j.output) || {};
  if (j && j.state) applyRealtimeState(j.state);
  if (Array.isArray(out.rejected)) {
    rt.rejected += out.rejected.length;
    if (out.rejected.length) {
      const labels = out.rejected.map(r => r && (r.label || r.field)).filter(Boolean);
      v.notice = 'Values refused as not said on the call: ' + out.rejected.length +
        (labels.length ? ' (' + labels.join(', ') + ')' : '') + '.';
    }
  }
  if (Array.isArray(out.accepted)) rt.accepted += out.accepted.length;
  if (out.end_attempts) rt.endAttempts = out.end_attempts;
  if (out.next && out.next.question_id && (out.next.kind === 'probe' || out.next.kind === 'callback')) {
    v.currentQuestionId = out.next.question_id; v.pendingQuestionId = out.next.question_id;
  }
  if (out.next && out.next.kind === 'probe' && out.question_id) v.probes[out.question_id] = (v.probes[out.question_id] || 0) + 1;
  if (out.close === true && job && job.name === 'end_call') rt.closing = true;
  const attribution = job && job.attribution;
  if (attribution && attribution.text === job.userTurn) {
    if (out.answer_quality === 'off_topic' || (out.saved === false && out.answer_quality !== 'declined')) {
      unrecordAttribution(attribution);
    }
    // A later caller turn may already have replaced the shared pointer while this validation ran.
    // Clear it only when it still refers to this job; every queued job keeps its own attribution.
    if (rt.pendingAttribution && rt.pendingAttribution.text === attribution.text) rt.pendingAttribution = null;
  }
  if (Array.isArray(j && j.warnings) && j.warnings.length) v.warnings = (v.warnings || []).concat(j.warnings);
  quietRealtimeCaptureNote(out, job, false);
  render();
  refreshFieldStatus();
}
function queueRealtimeValidation(job) {
  const v = voiceSync(); const rt = v.rt;
  rt.pendingValidations++;
  const previous = rt.validationQueue || Promise.resolve();
  const task = previous.catch(() => {}).then(async () => {
    try {
      // Build from the latest server-confirmed state, not the snapshot from another tool call in
      // this same caller turn. This serial client queue prevents parallel results overwriting one
      // another while the model itself receives each function output immediately.
      const j = await api.post('/api/voice/realtime/tool', {
        call_id: v.callId, call_ticket: rt.callTicket, name: 'record_answer', arguments: job.args,
        user_turn: job.userTurn, user_lines: job.userLines.slice(-4), ai_lines: job.aiLines.slice(-3),
        answers: answersForUpload(), asked: v.asked, probes: v.probes, skipped: v.skipped,
        voice_captures: v.captures, end_attempts: rt.endAttempts,
        client_name: (state.user && state.user.name) || ''
      });
      applyRealtimeToolResult(j, job);
    } catch (e) {
      if (rt.pendingAttribution && rt.pendingAttribution.text === job.userTurn) rt.pendingAttribution = null;
      v.notice = 'A save did not go through (' + e.message + '). The call carries on.';
      quietRealtimeCaptureNote({ question_id: job.args.question_id }, job, true);
      render();
    } finally {
      rt.pendingValidations = Math.max(0, rt.pendingValidations - 1);
    }
  });
  rt.validationQueue = task.catch(() => {});
  return rt.validationQueue;
}
async function onRealtimeTool(callId, name, argsRaw) {
  const v = voiceSync(); const rt = v.rt;
  if (!name) return;
  const key = String(callId || '') + ':' + name;
  if (rt.handled[key]) return; // arguments.done and output_item.done can report the same call
  rt.handled[key] = true;
  rt.toolCalls++;
  let args = argsRaw;
  if (typeof args === 'string') { try { args = JSON.parse(args); } catch (e) { args = {}; } }
  if (!args || typeof args !== 'object') args = {};
  v.status = 'thinking'; render();

  if (name === 'record_answer') {
    const question = (v.plan || []).find(q => q.id === args.question_id);
    const nextTopic = (v.plan || []).find(q => q.id === args.next_topic_id);
    if (nextTopic) { v.currentQuestionId = nextTopic.id; v.pendingQuestionId = nextTopic.id; }
    const attr = rt.pendingAttribution;
    if (attr && attr.text === rt.lastUserTurn && question) attr.qid = question.id;
    const job = {
      name: 'record_answer', args: Object.assign({}, args),
      userTurn: String(rt.lastUserTurn || args.answer_text || '').slice(0, 4000),
      attribution: attr && attr.text === rt.lastUserTurn ? { qid: question && question.id || attr.qid, text: attr.text } : null,
      userLines: rt.userLines.slice(-4), aiLines: rt.aiLines.slice(-3)
    };
    // Acknowledge the function call to Realtime immediately. Grounding continues on our server in
    // parallel; a refusal later becomes a quiet system item, not another spoken response.
    rtSend({
      type: 'conversation.item.create',
      item: {
        type: 'function_call_output', call_id: String(callId || ''),
        output: JSON.stringify({
          status: 'validation_pending', question_id: args.question_id || null,
          next_topic_id: nextTopic ? nextTopic.id : null,
          instruction: 'Validation is running privately. Acknowledge one specific detail from the caller and continue with one uncovered topic. Do not say any value has been saved.'
        })
      }
    });
    if (!rt.userSpeaking && !v.done) rtRespond();
    queueRealtimeValidation(job); // deliberately not awaited
    render();
    return;
  }

  // Ending is deliberately server-gated (stop and required-field checks). Wait for any queued
  // captures first so a parallel multi-topic turn cannot race its final call state.
  try { await (rt.validationQueue || Promise.resolve()).catch(() => {}); } catch (e) {}
  let out = null; let j = null;
  try {
    j = await api.post('/api/voice/realtime/tool', {
      call_id: v.callId, call_ticket: rt.callTicket, name, arguments: args,
      user_turn: rt.lastUserTurn, user_lines: rt.userLines.slice(-4), ai_lines: rt.aiLines.slice(-3),
      answers: answersForUpload(), asked: v.asked, probes: v.probes, skipped: v.skipped,
      voice_captures: v.captures, end_attempts: rt.endAttempts,
      client_name: (state.user && state.user.name) || ''
    });
    applyRealtimeToolResult(j, { name, args, userTurn: rt.lastUserTurn });
    out = (j && j.output) || { instruction: 'Carry on with the intake topics.' };
  } catch (e) {
    out = { error: e.message, instruction: 'Carry on with the intake topics.' };
    v.notice = 'A save did not go through (' + e.message + '). The call carries on.';
  }
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
  clearRealtimeSilenceTimers(true);
  touchActivity();
  rtSend({
    type: 'conversation.item.create',
    item: { type: 'message', role: 'user', content: [{ type: 'input_text', text: t.slice(0, 1200) }] }
  });
  rt.lastUserTurn = t;
  rt.userLines.push(t);
  if (rt.userLines.length > 12) rt.userLines.shift();
  rt.pendingAttribution = { qid: qid, text: t };
  v.transcript.push({ role: 'user', text: t, questionId: qid, typed: true });
  v.lastHeard = t;
  rtRespond('They typed that answer instead of speaking it. Treat it exactly as if they had said it. Record every distinct intake topic they answered, including volunteered topics, then continue with one uncovered topic.');
  render();
  refreshFieldStatus();
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
  if (!prev) { state.answers.push({ id, text: text }); saveJourneyState(); return; }
  if (replace) prev.text = text;
  else prev.text = (String(prev.text || '').trim() + ' ' + String(text || '').trim()).trim();
}
/* A question the lead asked, or a request to stop, is not an answer to the question on screen. The
   words are stored the moment they are said (so the transcript and the call state stay honest), then
   taken back out when the turn comes back saying it was a question or a stop. Splitting on the exact
   text also handles the probe case, where the stored answer is the old text plus this turn's. */
function unrecordAnswer(id, text) {
  if (!id || !text) return;
  const a = state.answers.find(x => x.id === id);
  if (!a) return;
  const keep = String(a.text || '').split(String(text)).join(' ').replace(/\s+/g, ' ').trim();
  if (keep) a.text = keep;
  else state.answers = state.answers.filter(x => x.id !== id); saveJourneyState();
}
function buildTurnBody(lastAnswer) {
  const v = voiceSync();
  return {
    call_id: v.callId, call_ticket: v.callTicket,
    current_question_id: v.currentQuestionId,
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
  v.callTicket = res.call_ticket; v.turns = res.turn;
  v.capture = res.capture; captureGen++;
  v.warnings = res.warnings || [];
  v.provider = res.provider; v.mode = res.mode;
  if (Array.isArray(res.voice_captures)) v.captures = res.voice_captures;
  if (res.ask && res.ask.id) {
    if (res.ask.kind === 'probe' || res.ask.kind === 'callback') v.probes[res.ask.id] = (v.probes[res.ask.id] || 0) + 1;
    /* A deferred turn is one the lead spent asking Nova things: the answer was the whole turn and
       the question was never asked, so it is not recorded as asked and comes back next turn. */
    if (!res.ask.deferred && !v.asked.includes(res.ask.id)) v.asked.push(res.ask.id);
    v.currentQuestionId = res.ask.id;
  } else {
    v.currentQuestionId = null;
  }
  v.done = !!res.done;
  if (res.stop_requested) v.stopped = true;
  v.lastLine = res.say;
  if (v.done) v.endedAt = new Date().toISOString();
  v.transcript.push({ role: 'ai', text: res.say, questionId: res.ask && res.ask.id ? res.ask.id : null });
  render();
}
async function afterTurn(res) {
  const v = voiceSync();
  await speakLine(res);
  if (v.done) { v.status = 'complete'; render(); return; }
  if (v.listening || v.listenPending) return;   // a hands-free listen is already in progress
  if (v.handsFree && !v.typed && !v.micBlocked && !v.micMuted) await listenForAnswer();
  else { v.status = 'ready'; render(); }
}
async function voiceTurn(userText) {
  const v = voiceSync();
  let recorded = null;
  if (userText != null) {
    const id = answerIdFor();
    recordAnswer(id, userText, false);
    recorded = { id: id, text: userText };
    v.transcript.push({ role: 'user', text: userText, questionId: id });
  }
  v.status = 'thinking'; v.interim = ''; v.error = null; v.notice = null;
  // The fallback notice stays up through the automatic continuation turn and goes away once the
  // visitor has answered something themselves, so they are not left wondering what happened.
  if (userText != null) v.rtNotice = null;
  render();
  let res;
  try {
    res = await api.post('/api/voice/turn', buildTurnBody(userText || null));
  } catch (e) {
    v.status = 'error'; v.error = e.message; render();
    return;
  }
  applyTurn(res);
  if (recorded && (res.deferred || res.stop_requested)) unrecordAnswer(recorded.id, recorded.text);
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
    if (rt && rt.failed && rt.failed !== 'realtime-disabled') {
      const code = recordVoiceFallback(rt.failed, {
        reportToServer: true,
        serverReported: !!rt.serverReported,
        showNotice: false
      });
      v.rtFallback = code !== 'no-key';
      if (code === 'mic-blocked') {
        v.micBlocked = true; v.micMuted = true; v.typed = true; v.typedFallback = true; v.status = 'ready';
        setFallbackNotice(isVoiceDiagnosticsVisible() ? VOICE_FALLBACK_COPY[code] : '');
        render();
        // Still start the same interviewer. The typed answer field is ready, and afterTurn will not
        // try to reopen a microphone that the browser has already denied.
        if (v.opening) { const first = v.opening; v.opening = null; applyTurn(first); afterTurn(first); }
        else voiceTurn(null);
        return;
      }
      setFallbackNotice(isVoiceDiagnosticsVisible() ? VOICE_FALLBACK_COPY[code] : '');
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
/* The hang-up report, shared by the End button, the model's own end_call, the session watchdog and
   the page-exit guard. `useBeacon` sends it with navigator.sendBeacon so it survives the tab
   closing without ever blocking navigation (no synchronous request during unload); the ordinary
   path waits for the server's final contract state so the review screen shows exactly what the live
   call produced, and nothing that failed grounding. */
function sendRealtimeEnd(v, useBeacon) {
  const body = {
    call_id: v.callId, answers: state.answers, asked: v.asked, probes: v.probes, skipped: v.skipped,
    voice_captures: v.captures,
    transcript: (v.transcript || []).slice(-30).map(t => ({ role: t.role, text: t.text }))
  };
  if (v.rt) v.rt.endedSent = true;
  const payload = JSON.stringify(Object.assign({ token: state.token }, body));
  if (useBeacon) {
    try {
      if (navigator.sendBeacon) {
        const blob = window.Blob ? new window.Blob([payload], { type: 'application/json' }) : payload;
        if (navigator.sendBeacon('/api/voice/realtime/end', blob)) return Promise.resolve(null);
      }
    } catch (e) {}
    // No beacon available (or it was refused): fire and forget with keepalive, never synchronously.
    try {
      const p = fetch('/api/voice/realtime/end', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, keepalive: true, body: payload
      });
      return p && typeof p.catch === 'function' ? p.catch(() => null) : Promise.resolve(null);
    } catch (e) { return Promise.resolve(null); }
  }
  return api.post('/api/voice/realtime/end', body).catch(() => null);
}
function finishCall() {
  const v = voiceSync();
  const rt = v.rt;
  stopSpeaking(); stopListening();
  v.endedAt = new Date().toISOString();
  const wasLive = !!(rt && (rt.live || rt.startedAt));
  if (wasLive) { rt.closing = true; if (rt.audioEl) { try { rt.audioEl.pause(); } catch (e) {} } }
  /* Stops the microphone tracks, the AI audio, the analyser, the data channel and the peer
     connection, and clears every timer this call armed. The transcript and state.answers are
     untouched, so everything the visitor said carries into the review screen. */
  cleanupRealtime();
  if (!wasLive) { startExtraction(); return; }
  sendRealtimeEnd(v, false).then(j => {
    if (j && j.capture) { v.capture = j.capture; captureGen++; }
    if (j && Array.isArray(j.voice_captures)) v.captures = j.voice_captures;
    if (j && j.provider) { v.provider = j.provider; v.mode = j.mode; }
    startExtraction();
  });
}
/* Closing the tab, refreshing or navigating away must not leave the microphone live, the peer
   connection open, the analyser running, or the call unreported. `pagehide` covers all three (and
   fires for bfcache entries, where `unload` no longer does); the report goes out as a beacon so
   navigation is never blocked. Tab visibility changes are deliberately NOT treated as an exit:
   locking a phone or switching apps must not hang up on someone. */
let pageExitArmed = false;
function armPageExitGuard() {
  if (pageExitArmed) return;
  pageExitArmed = true;
  const onExit = () => {
    const v = state.voice;
    const rt = v && v.rt;
    try {
      if (v && rt && (rt.live || rt.startedAt) && !rt.endedSent && !v.done) sendRealtimeEnd(v, true);
    } catch (e) {}
    cleanupRealtime();
  };
  try { window.addEventListener('pagehide', onExit); } catch (e) {}
}

/* ---------------- brand: the logo ----------------
 * The logo and the mascot are the brand components in public/components/brand/{Logo,Nova}.js:
 * the React components from the brand sheet ported to this no-build vanilla layer, with their SVG
 * markup, geometry and colours unchanged. They load before this file (see index.html).
 *
 * The UI no longer renders the mascot: only the logo appears on screen. The mascot's pose and size are
 * no longer derived from call state; the waveform follows the state the call is already in. */
const Logo = opts => window.PSBrand.Logo(opts);
const LogoMark = opts => window.PSBrand.LogoMark(opts);

/* True while the call is actually live: the AI is speaking, or the microphone is open. The
   waveform follows this, so one function answers for it. */
function novaWaveOn() {
  const v = state.voice;
  if (!v) return false;
  return v.status === 'speaking' || !!v.listening || !!(v.rt && v.rt.live);
}
/* The live state is repainted in place while the call runs. A full render would rebuild the call
   orb and lose its animation mid-sentence, exactly like the AI's line, so the waveform flag is
   swapped the same way: a cheap heartbeat reads the state the call is already in and only touches
   the DOM when it changed. It stops itself the moment the call screen is gone. */
let waveLiveTimer = null;
function refreshWaveLive() {
  const call = document.querySelector('.call');
  if (!call) {
    if (waveLiveTimer) { clearInterval(waveLiveTimer); waveLiveTimer = null; }
    return;
  }
  call.classList.toggle('nova-wave-live', novaWaveOn());
}
function armWaveLive() {
  refreshWaveLive();
  if (waveLiveTimer) return;
  waveLiveTimer = setInterval(refreshWaveLive, 300);
}

/* The animated waveform under the live question: nine bars in a #8FB0D0 -> #FF7A1A gradient. */
const NOVA_WAVE_BARS = [14, 20, 26, 18, 24, 30, 22, 27, 16];
function novaWaveHtml(id) {
  return '<div class="nova-wave"' + (id ? ' id="' + esc(id) + '"' : '') + ' aria-hidden="true">' +
    NOVA_WAVE_BARS.map((h, i) =>
      '<span class="nova-wave-bar" style="height:' + h + 'px;animation-delay:' + (-(i * 0.12).toFixed(2)) + 's"></span>').join('') +
    '</div>';
}
/* Loading mark uses the active surface palette without a white plate. */
function novaSplashHtml() {
  return '<div class="nova-splash" role="img" aria-label="Nova PipelineSync AI">' +
    '<span class="nova-splash-card" aria-hidden="true">' + LogoMark({ variant: brandVariant(), animated: true, size: 96 }) + '</span>' +
    '</div>';
}
/* The empty state: no data yet, so the screen offers the way in. */
function emptyHtml() {
  return '<div class="card hud-frame nova-empty">' +
    '<h2>No pipeline data yet</h2>' +
    '<div class="btn-row btn-row-center"><button class="btn btn-primary btn-lg" id="empty-start">Start strategy session</button></div>' +
  '</div>';
}

/* ---------------- rendering ---------------- */
function render() {
  const app = $('#app');
  document.body.classList.toggle('entry-screen', !state.token);
  document.body.classList.toggle('app-screen', !!state.token);
  document.body.dataset.theme = state.theme;
  document.documentElement.style.colorScheme = state.theme;
  // With a valid token, never show blank: unknown stage falls back to consent
  if (state.token) {
    if (!KNOWN_STAGES.has(state.stage)) {
      state.stage = 'consent';
    }
  }
  document.body.dataset.stage = state.token ? state.stage : 'start';
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
    default: h += consentView(); break;
  }
  h += '</main>' + footer();
  app.innerHTML = h;
  saveJourneyState();
  if (state.stage === 'intake') afterCallRender();
  if (state.stage === 'blueprint') animateNumbers();
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
/* Theme-following surfaces use matching mark colours. The voice orb stays dark
   in both themes, so its mark explicitly keeps the dark variant. */
function brandVariant() { return state.theme === 'light' ? 'light' : 'dark'; }
function logoTile(h) {
  return '<span class="logo-plate" style="width:' + (h * 222 / 162) + 'px;height:' + h + 'px">' +
    LogoMark({ variant: brandVariant(), size: h }) + '</span>';
}
/* The colour-mode switch was removed with the dark-only glass theme. */
function topbar() {
  const u = state.user || {};
  const name = esc(u.name || '');
  const initials = esc(u.initials || initialsFor(u.name));
  return '<header class="topbar">' +
    '<a class="skip-link" href="#main-content">Skip to content</a>' +
    '<div class="brand">' +
      '<span class="brand-logo">' + Logo({ variant: brandVariant(), size: 40 }) + '</span>' +
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
  /* The rail mirrors the journey order, not alphabetical stage names: the same
     label has to light up for every stage inside one phase, and the progress
     must never move backwards. consent/intake share "Discovery", extracting is
     the gap-analysis pass, review is "Review signals", generating + blueprint
     are "Blueprint", and booking + done are the final "Next Steps". */
  const order = ['intake', 'extracting', 'review', 'blueprint', 'booking', 'done'];
  const phaseOf = { consent: 0, intake: 0, extracting: 1, generating: 3 };
  let idx = phaseOf[state.stage];
  if (idx === undefined) idx = order.indexOf(state.stage);
  const labels = ['Discovery', 'Gap Analysis', 'Review', 'Blueprint', 'Next Steps'];
  const at = Math.max(0, Math.min(labels.length - 1, idx < 0 ? 0 : idx));
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
  return '<footer class="footer"><span>Nova PipelineSync AI</span><a href="/dev/outbox" target="_blank" rel="noopener">Outbox</a></footer>';
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
  let turnstileHtml = '';
  if (state.turnstileSiteKey) {
    turnstileHtml = '<div class="field"><div id="turnstile-widget"><div class="cf-turnstile" data-sitekey="' + esc(state.turnstileSiteKey) + '" data-callback="onTurnstileSuccess" data-expired-callback="onTurnstileExpired" data-error-callback="onTurnstileError"></div></div><p class="small txt-err" id="turnstile-error" role="alert" hidden></p></div>';
  }
  let demoHtml = '';
  if (state.demoMode) {
    demoHtml = '<div class="gate-alt"><span aria-hidden="true"></span>or<span aria-hidden="true"></span></div>' +
      '<button class="btn btn-ghost btn-block" id="demo-btn" type="button">Use the demo account</button>';
  }
  let privacyLink = '';
  if (state.privacyPolicyUrl) {
    privacyLink = ' <a href="' + esc(state.privacyPolicyUrl) + '" target="_blank" rel="noopener noreferrer">Privacy Policy</a>.';
  }
  const entryNotice = '<div class="notice info" id="entry-consent-notice"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><circle cx="12" cy="12" r="10"/><path d="M12 16v-4M12 8h.01"/></svg><div>Nova is an AI assistant. Your name, email and answers are saved to our CRM (HubSpot) so our team can follow up. The voice call is processed by OpenAI and your blueprint by Anthropic\'s Claude. Audio is never stored.' + privacyLink + '</div></div>';
  return '<div class="gate">' +
    '<div class="gate-brand">' +
      '<div class="gate-brand-inner">' +
        '<div class="brand brand-lg"><span class="brand-logo">' + Logo({ variant: brandVariant(), size: 54 }) + '</span></div>' +
        '<h1>Build a <span class="accent">predictable pipeline.</span></h1>' +
        '<p class="lede">AI discovery call. Personalised HubSpot blueprint.</p>' +
        '<div class="gate-trust">' +
          '<span class="trust-item telem"><span class="d" aria-hidden="true"></span>5 min</span>' +
          '<span class="trust-item telem"><span class="d" aria-hidden="true"></span>12 signals</span>' +
          '<span class="trust-item telem"><span class="d" aria-hidden="true"></span>Audio not stored</span>' +
        '</div>' +
      '</div>' +
    '</div>' +
    '<div class="gate-side"><div class="gate-card hud-frame specular">' +
      '<h2>Start strategy session</h2>' +
      '<p class="sub">Enter your details to start the AI voice call.</p>' +
      '<form id="start-form" novalidate>' +
        '<div class="field"><label for="st-name">Your name <span class="req">Required</span></label>' +
          '<input type="text" id="st-name" name="name" value="' + esc(lastName) + '" placeholder="Maria Santos" maxlength="80" autocomplete="name" autocapitalize="words" spellcheck="false">' +
        '</div>' +
        '<div class="field"><label for="st-email">Work email <span class="req">Required</span></label>' +
          '<input type="email" id="st-email" name="email" value="' + esc(lastEmail) + '" placeholder="you@yourbusiness.ph" maxlength="254" autocomplete="email" inputmode="email" spellcheck="false">' +
        '</div>' +
        entryNotice +
        turnstileHtml +
        '<p class="form-error" id="start-error" role="alert" hidden></p>' +
        '<button class="btn btn-primary btn-lg btn-block mt16" id="st-btn" type="submit">Start strategy session</button>' +
      '</form>' +
      demoHtml +
      '<p class="gate-note">Live transcription. Audio is never stored.</p>' +
    '</div></div>' +
  '</div>';
}
/* Turnstile callbacks — global so the widget can call them */
window.onTurnstileSuccess = function (token) {
  state.turnstileToken = String(token || '');
  const el = document.getElementById('turnstile-error');
  if (el) { el.hidden = true; el.textContent = ''; }
};
window.onTurnstileExpired = function () {
  state.turnstileToken = null;
  const el = document.getElementById('turnstile-error');
  if (el) { el.textContent = 'Turnstile expired. Please verify again.'; el.hidden = false; }
};
window.onTurnstileError = function () {
  state.turnstileToken = null;
  const el = document.getElementById('turnstile-error');
  if (el) { el.textContent = 'Turnstile could not load. Please refresh and try again.'; el.hidden = false; }
};
function ensureTurnstileScript() {
  if (!state.turnstileSiteKey) return;
  if (document.querySelector('script[src*="challenges.cloudflare.com/turnstile"]')) return;
  const s = document.createElement('script');
  s.src = 'https://challenges.cloudflare.com/turnstile/v0/api.js';
  s.async = true;
  s.defer = true;
  document.head.appendChild(s);
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
    if (demoBtn) { demoBtn.disabled = false; demoBtn.textContent = 'Use the demo account'; }
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
    if (state.turnstileSiteKey && !state.turnstileToken) {
      const tErr = document.getElementById('turnstile-error');
      if (tErr) { tErr.textContent = 'Please complete the Turnstile verification.'; tErr.hidden = false; }
      return fail('Please complete the Turnstile verification.', null);
    }
    if (btn) { btn.disabled = true; btn.textContent = 'Connecting you to the AI...'; }
    const payload = { name: cleanName, email: cleanEmail };
    if (state.turnstileToken) payload.turnstileToken = state.turnstileToken;
    fetch('/api/auth/start', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) })
      .then(async r => {
        const j = await r.json().catch(() => ({}));
        if (!r.ok) throw new Error(j.error || 'HTTP ' + r.status);
        return j;
      })
      .then(j => {
        state.token = j.token;
        state.user = j.user;
        state.hubspot = j.hubspot || { mocked: true, ok: false };
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
  if (nameEl && !nameEl.value) nameEl.focus();
  else if (emailEl && !emailEl.value) emailEl.focus();
  if (state.turnstileSiteKey) ensureTurnstileScript();
}

/* ---------------- consent ---------------- */
function consentView() {
  let privacyLink = '';
  if (state.privacyPolicyUrl) {
    privacyLink = ' <a href="' + esc(state.privacyPolicyUrl) + '" target="_blank" rel="noopener noreferrer">Privacy Policy</a>.';
  }
  return '<div class="card consent-card hud-frame specular">' +
    '<div class="telem cy mb12"><span class="d" aria-hidden="true"></span>CONSENT</div>' +
    '<h2>Ready to start?</h2>' +
    '<p>You\'ll be speaking with Nova, an AI.</p>' +
    '<div class="notice info" id="consent-notice">' +
      '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><circle cx="12" cy="12" r="10"/><path d="M12 16v-4M12 8h.01"/></svg>' +
      '<div>Your name, email and answers are saved to our CRM (HubSpot) so our team can follow up. The voice call is processed by OpenAI and your blueprint by Anthropic\'s Claude. Audio is never stored.' + privacyLink + '</div>' +
    '</div>' +
    '<label class="checkline"><input type="checkbox" id="consent-cb"> I agree to continue.</label>' +
    '<div class="btn-row"><button class="btn btn-primary btn-lg" id="consent-go" disabled>Agree and start the voice call</button></div>' +
    '<p class="small muted mt8" id="consent-note">Nova starts speaking automatically. You can skip or type.</p>' +
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
  if (!v.cfg && !v.mode) return '';
  if (wasRealtime(v)) return '<span class="badge-mode openai">Live voice</span>';
  const openai = isOpenAIStepVoice(v);
  return '<span class="badge-mode ' + (openai ? 'openai' : 'simulated') + '\">' +
    (openai ? 'Step-by-step voice' : 'Browser voice (no API key)') + '</span>';
}
function isOpenAIStepVoice(v) {
  v = v || voiceSync();
  return v.mode === 'openai' || v.provider === 'openai' ||
    v.provider === 'openai-realtime' || !!(v.cfg && v.cfg.provider === 'openai');
}
/* Was this call held over one continuous WebRTC session? The answer has to survive the hang-up
   (cleanupRealtime clears rt.live but keeps rt.startedAt) and must never be claimed for a call that
   fell back to the step-by-step engine. */
function wasRealtime(v) {
  v = v || voiceSync();
  if (v.rtFallback) return false;
  if (v.mode === 'realtime') return true;
  return !!(v.rt && v.rt.startedAt);
}
/* Use the same exact mode label in the call head and the review screen as in the mode badge.
   Realtime model/voice/turn-detection details are displayed separately in the mode card. */
function callModeLabel(v) {
  v = v || voiceSync();
  if (wasRealtime(v)) return 'Live voice';
  if (isOpenAIStepVoice(v)) return 'Step-by-step voice';
  return 'Browser voice (no API key)';
}
function voiceOrbHtml(status, listening) {
  const st = esc(status || 'idle');
  const isSpeakingOrListening = status === 'speaking' || listening;
  const waveHtml = '<div class="wave' + (isSpeakingOrListening ? ' active' : '') + '" aria-hidden="true">' +
    '<span></span><span></span><span></span><span></span><span></span><span></span><span></span><span></span><span></span>' +
    '</div>';
  return '<div class="voice-orb-container">' +
    '<div class="orb ' + st + (listening ? ' live' : '') + '" id="orb" role="img" aria-label="Call state: ' + st + '">' +
      '<div class="gyro-sphere" aria-hidden="true">' +
        '<div class="gyro-ring ring-cyan"></div>' +
        '<div class="gyro-ring ring-rose"></div>' +
        '<div class="gyro-ring ring-amber"></div>' +
        '<div class="gyro-ring ring-dashed"></div>' +
        '<div class="gyro-ring ring-violet"></div>' +
        '<div class="gyro-core"></div>' +
      '</div>' +
      '<div class="reticle" aria-hidden="true"><span></span><span></span><span></span><span></span></div>' +
      '<div class="orb-center">' +
        LogoMark({ variant: 'dark', size: 24 }) +
        waveHtml +
      '</div>' +
    '</div>' +
  '</div>';
}

function callView() {
  const v = voiceSync();
  const started = !!v.startedAt || v.transcript.length > 0;
  const statusText = (v.mode === 'realtime' ? RT_STATUS_TEXT[v.status] : VOICE_STATUS_TEXT[v.status]) ||
    VOICE_STATUS_TEXT[v.status] || VOICE_STATUS_TEXT.idle;
  const aiLine = v.lastLine || "Hi, I'm Nova. Let's map how your deals actually move.";
  const youLine = v.interim || v.lastHeard || '';

  /* The live call screen, built for a natural voice conversation: the orb on top as the presence
     meter, the voice subtitles (the AI's line, the waveform, your live answer) below it, and the
     status and controls pinned at the bottom. No question counter - the conversation leads. The
     waveform animates while the call is live. */
  const waveOn = novaWaveOn();

  let h = '<div class="intake-wrap' + (state.demoMode ? '' : ' call-only') + '"><div class="call hud-frame' + (waveOn ? ' nova-wave-live' : '') + '">' +
    '<div class="call-head"><div class="who"><div><b>Nova</b><span class="small muted" id="call-mode">' +
      (v.cfg ? callModeLabel(v) : 'Connecting...') + '</span></div></div>' +
      '<div class="call-head-right">' +
      (state.demoMode ? '<button class="btn btn-ghost btn-sm side-toggle" id="side-toggle" type="button" aria-expanded="' + (state.sideOpen ? 'true' : 'false') + '" aria-controls="intake-side">Demo tools</button>' : '') + '</div></div>' +
    '<div class="call-body">' +
      '<div class="nova-stepper">' + voiceOrbHtml(v.status, v.listening) + '</div>' +
      '<div class="nova-live">' +
        '<div class="nova-live-main">' +
          '<div class="nova-question" id="ai-line" aria-live="polite">' + esc(aiLine) + '</div>' +
          novaWaveHtml('nova-wave') +
          (youLine ? '<div class="line you" id="you-line">' + esc(youLine) + '</div>' : '<div class="line you empty" id="you-line">Your answer appears here as you speak.</div>') +
        '</div>' +
      '</div>' +
      '<div class="call-status" id="call-status" role="status" aria-live="polite">' + esc(statusText) + '</div>' +
      (v.rtNotice ? '<div class="call-note">' + esc(v.rtNotice) + '</div>' : '') +
      (v.notice ? '<div class="call-note">' + esc(v.notice) + '</div>' : '') +
      (state.fieldError ? '<p class="call-note err" role="alert">' + esc(state.fieldError) + '</p>' : '') +
      (v.error ? '<div class="call-note err">' + esc(v.error) + ' <button class="btn btn-ghost btn-sm" id="retry-turn">Retry</button></div>' : '') +
    '</div>' +
    '<div class="call-controls" id="call-controls">' + callControls(started) + '</div>' +
    '</div>' + callSidebar() + '</div>';
  return h;
}
function callControls(started, total) {
  const v = voiceSync();
  const rt = v.rt;
  if (rt && (rt.live || rt.connecting)) {
    /* Minimal controls for a natural conversation: my microphone, the AI's speaker, and the way
       out. Type instead stays beside them because it is useful mid-call. Microphone mute and
       speaker mute are separate buttons and say which is which. */
    let h = '<div class="call-row">';
    h += '<button class="btn ' + (rt.micMuted ? 'btn-ghost' : 'btn-dark') + '" id="mic-btn" type="button" aria-pressed="' + (rt.micMuted ? 'false' : 'true') + '" title="Mute or unmute your microphone">' +
      (rt.micMuted ? 'Microphone muted' : 'Microphone live') + '</button>';
    h += '<button class="btn ' + (v.muted ? 'btn-ghost' : 'btn-dark') + '" id="mute-btn" type="button" aria-pressed="' + (v.muted ? 'false' : 'true') + '" title="Mute or unmute the AI voice">' +
      (v.muted ? 'Speaker muted' : 'Speaker on') + '</button>';
    h += '<button class="btn btn-ghost" id="type-btn">Type instead</button>';
    h += '</div>';
    if (!v.done) {
      h += '<div class="call-row"><button class="btn btn-end" id="end-call-btn" type="button" title="Stop the call and review what we captured">End conversation</button></div>';
    }
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
  // The call is hands-free: Nova speaks, then listens, automatically. The button is the override -
  // stop Nova mid-line (tap barge-in), send the answer early, or answer when she missed you.
  const micLabel = v.listening ? '&#9632; Stop and send' : (v.status === 'speaking' ? '&#9632; Stop' : '&#127908; Answer');
  h += '<button class="btn ' + (v.listening ? 'btn-dark' : 'btn-primary') + '" id="mic-btn" aria-pressed="' + (v.listening ? 'true' : 'false') + '"' +
    (v.status === 'thinking' || v.done ? ' disabled' : '') + '>' + micLabel + '</button>';
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
  if (!state.demoMode) return '';
  let personaCard = '';
  if (state.demoMode) {
    const personaOpts = Object.keys(PERSONAS).map(k => '<option value="' + k + '">' + PERSONAS[k].label + '</option>').join('');
    const quickBtns = Object.keys(PERSONAS).map(k => '<button class="btn btn-ghost btn-sm" data-persona="' + k + '">' + k + '</button>').join('');
    personaCard = '<div class="side-card"><h3>Demo data</h3><div class="persona">' +
      '<label for="persona-sel">QA shortcut: load a demo business</label>' +
      '<select id="persona-sel"><option value="">Choose a vertical...</option>' + personaOpts + '</select>' +
      '<button class="btn btn-ghost btn-sm" id="persona-go" style="width:100%">Load demo answers</button>' +
      '<p class="hint" style="font-size:11.5px;color:var(--faint);margin-top:8px">Runs the four verticals from the QA checklist without a microphone.</p>' +
      '<div class="persona-quick" style="margin-top:8px;display:flex;gap:6px;flex-wrap:wrap">' + quickBtns + '</div>' +
      '</div></div>';
  }
  return '<aside class="intake-side" id="intake-side" aria-label="Demo tools">' +
    personaCard + '</aside>';
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
  // The call body scrolls on short screens: keep the live answer line in view
  // while the visitor speaks, without moving anything they are reading.
  if (txt && typeof el.scrollIntoView === 'function') {
    try { el.scrollIntoView({ block: 'nearest' }); } catch (e) { /* older engines: plain call */ try { el.scrollIntoView(); } catch (e2) {} }
  }
}
function bindCall() {
  const v = voiceSync();
  const start = $('#start-call');
  if (start) start.onclick = () => startCall();
  const preType = $('#type-btn-pre');
  if (preType) preType.onclick = () => { v.typed = true; v.micMuted = true; v.startedAt = v.startedAt || new Date().toISOString(); render(); };
  const mic = $('#mic-btn');
  if (mic) mic.onclick = () => {
    // On a live call the microphone stays open. Stop and send submits the current utterance;
    // otherwise the control interrupts speech or starts a listen when Nova missed the turn.
    if (v.rt && v.rt.live) { setRealtimeMicMuted(!v.rt.micMuted); render(); return; }
    if (v.listening) { stopListening(true); return; }
    if (v.status === 'speaking') stopSpeaking();
    if (v.typed && !v.typedFallback) { v.typed = false; v.micMuted = false; }
    listNow();
  };
  const micBack = $('#mic-back-btn');
  if (micBack) micBack.onclick = () => {
    if (v.rt && v.rt.live) { v.typed = false; setRealtimeMicMuted(false); render(); return; }
    stopListening(); v.typed = false; v.typedFallback = false; v.micBlocked = false; v.micMuted = false;
    render(); listNow();
  };
  const stopSpeak = $('#stop-speak');
  if (stopSpeak) stopSpeak.onclick = () => { stopSpeaking(); v.status = v.done ? 'complete' : 'ready'; render(); };
  const typ = $('#type-btn');
  if (typ) typ.onclick = () => {
    stopListening();
    v.typed = true;
    if (v.rt && v.rt.live) setRealtimeMicMuted(true);
    else v.micMuted = true;
    v.status = 'ready'; render();
    const i = $('#intake-input'); if (i) i.focus();
  };
  const mute = $('#mute-btn');
  if (mute) mute.onclick = () => {
    if (v.rt && v.rt.live) { setRealtimeSpeakerMuted(!v.muted); render(); return; }
    v.muted = !v.muted; if (v.muted) stopSpeaking(); render();
  };
  const skip = $('#skip-btn');
  if (skip) skip.onclick = () => skipQuestion();
  /* The manual way out of a live call. finishCall() already stops the microphone tracks, stops the
     AI audio, closes the data channel and the peer connection, reports the hang-up to
     /api/voice/realtime/end, keeps the transcript and every captured answer, and carries on into
     the review flow - so the button reuses it rather than duplicating any of that. */
  const endBtn = $('#end-call-btn');
  if (endBtn) endBtn.onclick = () => finishCall();
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
  armWaveLive();   // the waveform follows the live state while the call is on screen
  const body = $('#chat-body');
  if (body) body.scrollTop = body.scrollHeight;
  updateLiveLine();
  updateConnNote();
  // Warm the session and the opening line while the client reads the screen, so the AI can speak
  // inside the click that starts the call.
  if (state.stage === 'intake' && !v.startedAt && !v.opening && !v.prefetching && !v.prefetchTried) prefetchOpening();
}

/* ---------------- capture status and hand-off to Function A ---------------- */
/* Extract responses are tagged and dropped when they are no longer the latest: a live call can
   have several in flight, and an older response landing after a newer one would roll the captured
   signals panel backwards (values flipping back to "not yet" mid-call). `captureGen` counts every
   capture state the call itself writes, so an extract computed before the latest turn or tool
   result can never overwrite it. */
let fieldStatusSeq = 0;
let captureGen = 0;
async function refreshFieldStatus() {
  const v = voiceSync();
  if (!state.answers.length) return;
  const seq = ++fieldStatusSeq;
  const gen = captureGen;
  const answersSnapshot = state.answers;
  try {
    const j = await api.post('/api/extract', { answers: answersSnapshot });
    // The answers moved on (a later turn, a live tool result, or a newer refresh) while this
    // extract was in flight: what it computed is older than what the panel already shows.
    if (seq !== fieldStatusSeq || gen !== captureGen || answersSnapshot !== state.answers) return;
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
    // Keep the hardening intent: a failed live preview is surfaced, not swallowed. A stale
    // failure must not overwrite the note from a newer refresh either.
    if (seq !== fieldStatusSeq) return;
    state.fieldError = 'Could not update the live capture list: ' + e.message;
  }
}
function voiceMeta() {
  const v = state.voice;
  if (!v || !v.startedAt) return null;
  const end = v.endedAt ? new Date(v.endedAt) : new Date();
  const dur = Math.max(0, Math.round((end - new Date(v.startedAt)) / 1000));
  const rt = v.rt;
  const realtime = wasRealtime(v);
  const latency = summarizeRealtimeLatency(rt && rt.latencySamples);
  return {
    provider: v.provider, mode: v.mode,
    models: v.cfg ? v.cfg.models : null, tts_voice: v.cfg ? v.cfg.tts_voice : null,
    language: (v.cfg && v.cfg.language) || null,
    call_id: v.callId, started_at: v.startedAt, ended_at: v.endedAt,
    duration_s: dur, turns: v.turns,
    median_ms: latency.median_ms, p90_ms: latency.p90_ms, turns_measured: latency.turns_measured,
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
    fallback_reason: normalizeVoiceFallback(v.fallbackReason),
    audio_retained: false
  };
}
async function startExtraction() {
  const v = state.voice;
  trackLeadProgress('discovery_completed', { answers: state.answers, voice_meta: voiceMeta() });
  if (v && v.capture) {
    console.log('[voice] call finished: provider=' + v.provider + ' mode=' + v.mode + ' turns=' + v.turns +
      ' captured=' + v.capture.filledCount + '/' + v.capture.totalCount +
      ' missing_required=' + JSON.stringify(v.capture.missingRequired || []) + ' audio_retained=false');
  }
  await continueExtraction();
}
/* The structuring pass itself (Function A), split out from startExtraction so a reload that lands
   on the "Structuring your signals" loader can pick the pass back up instead of hanging there. */
async function continueExtraction() {
  state.stage = 'extracting';
  // Real state only: the loader reflects the in-flight request, never a timed animation.
  state.progress = { label: 'Structuring your answers', percent: null };
  render();
  try {
    const j = await api.post('/api/extract', { answers: state.answers });
    state.fields = j.fields;
    state.stage = 'review';
    render();
  } catch (e) {
    state.stage = 'intake';
    render();
    toast(e.message, true);
    // The answers themselves are still here: rebuild the live capture list from them, so the
    // visitor sees everything already captured instead of an empty panel.
    refreshFieldStatus();
  }
}
/* Re-attach to a blueprint job after a reload: the job record still holds the finished document,
   so the loader resumes on real server progress and the blueprint pops in when it is read. */
async function resumeGeneration(jobId, thenStage) {
  state.progress = state.progress || { label: 'Working', percent: null };
  state.stage = 'generating';
  render();
  try {
    const bp = await pollGeneration(jobId);
    state.blueprint = bp.blueprint;
    state.blueprintSource = bp.source || null;
    if (bp.fields) state.fields = bp.fields;
    state.stage = (thenStage === 'booking' || thenStage === 'done') ? thenStage : 'blueprint';
    state.progress = null;
    render();
  } catch (e) {
    state.progress = null;
    state.stage = state.fields ? 'review' : 'consent';
    render();
    toast(e.message, true);
  }
}
/* A reload mid-journey must come back with what was already captured. The saved answers are the
   record of the call so far: topics already answered are not asked again (and their text is never
   appended twice), the captured-signals panel is rebuilt from them, and a structuring pass that the
   reload interrupted is continued rather than abandoned on its loader. */
function resumeJourneyAfterReload() {
  const v = voiceSync();
  if (state.answers.length) {
    const answered = state.answers.filter(a => String(a.text || '').trim()).map(a => a.id);
    if (answered.length && !v.asked.length) v.asked = answered;
  }
  if (state.stage === 'intake') { refreshFieldStatus(); return; }
  if (state.stage === 'extracting') { continueExtraction(); return; }
  if (state.stage === 'review' && !state.fields && state.answers.length) { continueExtraction(); return; }
  const needsBlueprint = state.stage === 'generating' || state.stage === 'blueprint' ||
    state.stage === 'booking' || state.stage === 'done';
  if (needsBlueprint && !state.blueprint) {
    if (state.jobId) { resumeGeneration(state.jobId, state.stage); return; }
    // Nothing left to rebuild the document from: back to the last screen that still has its data.
    state.progress = null;
    state.stage = state.fields ? 'review' : (state.answers.length ? 'intake' : 'consent');
    render();
  }
}

/* ---------------- loader ---------------- */
function loaderView(kind) {
  const title = kind === 'extracting' ? 'Structuring your signals' : 'Building your blueprint';
  const sub = kind === 'extracting' ? 'Turning the call into a verified data set.' : 'Matching your numbers to the right HubSpot system.';
  const p = state.progress || {};
  const pct = typeof p.percent === 'number' ? Math.max(0, Math.min(100, p.percent)) : null;
  let h = '<div class="card loader hud-frame">' +
    '<div class="scanline-sweep" aria-hidden="true"></div>' +
    // The loading splash: the animated light mark on its white card, as the brand sheet asks.
    novaSplashHtml() +
    '<div class="telemetry-chip mb12"><span class="dot" aria-hidden="true"></span>AI ADVISOR SYNTHESIS &bull; ACTIVE</div>' +
    '<h2>' + title + '</h2><p class="sub">' + sub + '</p>' +
    '<div class="lstep active" id="loader-step" role="status" aria-live="polite">' +
      '<span class="ic" aria-hidden="true"></span>' + esc(p.label || 'Working') +
      (pct != null ? ' (' + pct + '%)' : '') +
    '</div>';
  if (pct != null) {
    h += '<div class="progressbar" role="progressbar" aria-valuemin="0" aria-valuemax="100" aria-valuenow="' + pct + '">' +
      '<div id="gen-bar" style="width:' + pct + '%"></div></div>';
  }
  return h + '</div>';
}

/* ---------------- review ---------------- */
function reviewView() {
  const f = state.fields;
  // Nothing captured yet (a session opened without a call): say so and offer the way in,
  // rather than the screen reading a field set that does not exist.
  if (!f) return emptyHtml();
  const isNull = v => v === null || v === '' || (Array.isArray(v) && !v.length);
  // What the voice model says it heard on the call, used only to help fill gaps the parser missed.
  const heard = (state.voice && state.voice.capture && state.voice.capture.heard) || {};
  const heardNote = k => {
    const h = heard[k];
    if (!h) return '';
    return '<div class="heard">Heard: <b>' + esc(h.value) + '</b>' +
      (h.evidence ? ' <span>("' + esc(String(h.evidence).slice(0, 110)) + '")</span>' : '') +
      '<button class="btn btn-ghost btn-sm" data-heard="' + k + '">Use</button></div>';
  };
  const groupHtml = (title, fields) => {
    let h = '<div class="review-group hud-frame"><h3>' + esc(title) + '</h3><div class="review-grid">';
    fields.forEach(cfg => {
      const v = f[cfg.k];
      const nullish = isNull(v);
      const req = cfg.required ? ' <span class="req">REQUIRED</span>' : '';
      const badge = nullish ? '<span class="nullbadge">Missing</span>' : '';
      const full = cfg.full ? ' review-full' : '';
      if (cfg.type === 'products') {
        const rows = (f.products || []).map((p, i) =>
          '<tr><td><input type="text" data-prod="' + i + '" data-pk="name" value="' + esc(p.name) + '" maxlength="200" aria-label="Product name"></td>' +
          '<td class="col-price"><input type="number" inputmode="decimal" step="any" data-prod="' + i + '" data-pk="price" value="' + esc(p.price) + '" placeholder="PHP" aria-label="Product price"></td>' +
          '<td class="col-pre"><input type="text" data-prod="' + i + '" data-pk="prerequisite" value="' + esc(p.prerequisite) + '" placeholder="Needs..." maxlength="200" aria-label="Prerequisite"></td>' +
          '<td><button class="del" data-del-prod="' + i + '" title="Remove row" aria-label="Remove product">&times;</button></td></tr>'
        ).join('');
        h += '<div class="field review-full' + (nullish ? ' is-null' : '') + '"><label>Products and services ' + badge + '</label>' +
          '<div class="tbl-wrap"><table class="tbl tbl-edit"><tr><th>Product / service</th><th>Price</th><th>Prerequisite</th><th class="col-del"><span class="sr-only">Remove</span></th></tr>' + rows + '</table></div>' +
          '<button class="btn btn-ghost btn-sm mt8" id="add-prod">Add product</button></div>';
      } else if (cfg.type === 'sources') {
        const rows = (f.lead_sources || []).map((s, i) =>
          '<tr><td><input type="text" data-src="' + i + '" data-sk="source" value="' + esc(s.source) + '" maxlength="100" aria-label="Lead source"></td>' +
          '<td class="col-vol"><input type="number" inputmode="numeric" step="1" data-src="' + i + '" data-sk="monthly_volume" value="' + esc(s.monthly_volume) + '" placeholder="per month" aria-label="Monthly volume"></td>' +
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
        const numeric = cfg.type === 'money' || cfg.type === 'number';
        const ph = cfg.type === 'money' ? 'PHP amount' : cfg.type === 'number' ? 'Number' : 'Text';
        // Keep the native type in sync with data-type. Without an explicit type these controls
        // fall back to the browser's unstyled default input, because the design-system rules
        // target .field input[type=text] and .field input[type=number]. inputmode keeps the
        // numeric keypad consistent with the native numeric control.
        const inputType = numeric ? 'number' : 'text';
        const inputMode = numeric ? ' inputmode="decimal" step="any"' : '';
        h += '<div class="field' + (nullish ? ' is-null' : '') + full + '"><label>' + esc(cfg.label) + req + badge + '</label>' +
          '<input data-key="' + cfg.k + '" data-type="' + (numeric ? 'number' : 'text') + '" type="' + inputType + '"' + inputMode + ' value="' + esc(v) + '" placeholder="' + ph + '" maxlength="200">' +
          (nullish ? heardNote(cfg.k) : '') + '</div>';
      }
    });
    return h + '</div></div>';
  };
  const groups = [
    ['1. Deal economics', [
      { k: 'typical_deal_size', label: 'Typical deal size', type: 'money', required: true },
      { k: 'monthly_lead_volume', label: 'Monthly lead volume', type: 'number', required: true },
      { k: 'close_rate', label: 'Close rate (%)', type: 'number', required: true },
      { k: 'monthly_deal_volume', label: 'Monthly deal volume', type: 'number' },
      { k: 'sales_cycle_length', label: 'Sales cycle length (weeks)', type: 'number' }
    ]],
    ['2. Sales motion', [
      { k: 'close_type', label: 'Close type', type: 'select', options: ['one-call', 'two-call'] },
      { k: 'sales_reps_on_calls', label: 'Sales reps on calls', type: 'number' },
      { k: 'sales_process_notes', label: 'Sales process notes', type: 'textarea' }
    ]],
    ['3. Lead channels & stack', [
      { k: 'lead_sources', label: '', type: 'sources', full: true },
      { k: 'lead_capture_method', label: 'Lead capture method', type: 'text' },
      { k: 'current_crm', label: 'Current CRM', type: 'text' },
      { k: 'current_hubspot_tier', label: 'Current HubSpot tier', type: 'text' },
      { k: 'current_tools', label: '', type: 'tags', full: true }
    ]],
    ['4. Operations', [
      { k: 'industry', label: 'Industry (vertical)', type: 'text' },
      { k: 'business_description', label: 'Business description', type: 'textarea' },
      { k: 'products', label: '', type: 'products', full: true },
      { k: 'fulfilment_headcount', label: 'Fulfilment headcount', type: 'number' },
      { k: 'fulfilment_method', label: 'Fulfilment method', type: 'text' },
      { k: 'marketing_ops_owner', label: 'Marketing and ops owner', type: 'text' }
    ]],
    ['5. Growth targets', [
      { k: 'biggest_headache', label: 'Biggest headache', type: 'textarea' },
      { k: 'six_month_goal', label: 'Six-month goal', type: 'textarea' },
      { k: 'monthly_marketing_spend', label: 'Monthly marketing spend', type: 'money' },
      { k: 'monthly_software_budget', label: 'Monthly software budget', type: 'money' }
    ]]
  ];
  const v = state.voice;
  /* main's review screen grew a local `callModeLabel` string for the same three cases. It shadowed
     the module-level callModeLabel(v) that the call head also uses, and the review screen called
     that shadow as a function - a guaranteed TypeError the moment a call was reviewed. One label
     function, shared by the call head and the review screen, is the merge of the two intents. */
  const callLine = v && v.startedAt
    ? '<div class="call-summary">' + providerBadge() + ' <span class="small muted">' + callModeLabel(v) +
      ' &bull; ' + v.turns + ' turns &bull; audio not retained</span></div>'
    : '';
  let h = '<div class="card hud-frame"><div class="review-header"><h2>Review signals</h2>' + callLine + '</div>';
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
  state.fields = fields; saveJourneyState();
  state.stage = 'generating';
  // Real progress: the server reports the step it is actually on. No timed animation,
  // and the blueprint screen is only shown when the API says the job is done.
  state.progress = { label: 'Queued', percent: 0 };
  render();
  try {
    const started = await api.post('/api/generate', { fields });
    if (!started.jobId) throw new Error('The blueprint job could not be started. Please try again.');
    state.jobId = started.jobId;
    const bp = await pollGeneration(started.jobId);
    state.blueprint = bp.blueprint;
    state.blueprintSource = bp.source || null;
    // Prefer fields from job record if available (server-side source of truth)
    if (bp.fields) state.fields = bp.fields;
    state.stage = 'blueprint';
    state.progress = null;
    render();
  } catch (e) {
    state.stage = 'review';
    state.progress = null;
    render();
    if (e.body && e.body.fieldErrors) {
      state.fieldErrors = e.body.fieldErrors;
      toast(Object.values(e.body.fieldErrors).join(' '), true);
    } else {
      toast(e.message, true);
    }
  }
}

/* Poll /api/generate/status every 2s until the job really finishes.
   Resolves only on status "done" with a blueprint; anything else throws. */
const GEN_POLL_MS = 2000;
const GEN_POLL_MAX_MS = 15 * 60 * 1000;
async function pollGeneration(jobId) {
  const deadline = Date.now() + GEN_POLL_MAX_MS;
  let misses = 0;
  while (Date.now() < deadline) {
    await sleep(GEN_POLL_MS);
    let j;
    try {
      j = await api.get('/api/generate/status?jobId=' + encodeURIComponent(jobId));
    } catch (e) {
      // A 404 straight after dispatch can mean the job record has not landed yet.
      if (e.status === 404 && ++misses <= 3) continue;
      throw e;
    }
    misses = 0;
    state.progress = { label: j.label || 'Working', percent: typeof j.progress === 'number' ? j.progress : null };
    if (state.stage === 'generating') render();
    if (j.status === 'error') {
      const err = new Error(j.error || 'We could not generate your blueprint. Please try again.');
      err.body = j;
      throw err;
    }
    if (j.status === 'done') {
      if (!j.blueprint) throw new Error('The blueprint came back empty. Please try again.');
      return j;
    }
  }
  throw new Error('The blueprint is taking longer than expected. Please try again.');
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
  const gapCards = '<div class="gap-analysis-grid">' +
    '<div class="gap-card"><h4>⚡ The biggest operational gap</h4><p>' + gapText + '</p></div>' +
    '<div class="change-card"><h4>✦ The single most important change</h4><p>' + changeText + '</p></div>' +
    '</div>';

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

  let h = '<div class=\"doc hud-frame' + (delivered ? ' nova-celebrate' : '') + '\">' +
    '<div class=\"doc-head\"><div class=\"telem cy mb12\"><span class=\"d\" aria-hidden=\"true\"></span>BLUEPRINT VERIFIED</div>' +
    '<div class=\"kicker\">Nova PipelineSync AI  |  ' + esc(bp.meta.verticalLabel).toUpperCase() + '</div>' +
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
    '<p class=\"mt8\">Generated by Nova PipelineSync AI from your confirmed answers. Figures are planning estimates, not a quote. Prepared in UK English.</p></div>' +
    '</div>';

  h += '<div class=\"btn-row\">' +
    '<button class=\"btn btn-primary btn-lg\" id=\"download-pdf-btn\" aria-label=\"Download blueprint as PDF\">&#11015; Download PDF</button>' +
    (delivered
      ? '<button class=\"btn btn-ghost\" id=\"redownload-btn\" aria-label=\"Download server PDF\">&#11015; Server PDF</button>' +
        '<button class=\"btn btn-amber\" id=\"book-btn\">Talk to a consultant</button>'
      : '<button class=\"btn btn-ghost\" id=\"unlock-btn\">Unlock & email PDF</button>' +
        '<button class=\"btn btn-amber\" id=\"book-btn\">Talk to a consultant</button>') +
    '</div>';

  if (delivered) {
    const hs = delivered.hubspot || {};
    const title = hs.mocked
      ? 'PDF ready'
      : (hs.ok && hs.contactId ? 'PDF ready - HubSpot synced' : 'PDF ready - CRM sync pending');
    h += '<div class=\"success-card\" role=\"status\"><h3>&#10003; ' + title + '</h3>';
    if (hs.ok && hs.contactId && !hs.mocked) {
      h += '<div class=\"kv\"><span class=\"k\">HubSpot contact ID</span><span class=\"v mono\">' + esc(hs.contactId) + '</span></div>';
    } else if (!hs.mocked) {
      h += '<div class=\"kv\"><span class=\"k\">CRM</span><span class=\"v\">saved - CRM sync pending</span></div>';
    }
    // Phase 3: the email line reports exactly what the deliver API said, and the reason comes
    // from the API too, so a failed send is never dressed up as a success.
    const mail = emailStatusOf(delivered);
    h += '<div class=\"kv\"><span class=\"k\">Delivered to</span><span class=\"v\">' + esc(delivered.email) + '</span></div>' +
      '<div class=\"kv\"><span class=\"k\">Emailed</span><span class=\"v\">' + esc(mail.text) + '</span></div>' +
      '<div class=\"kv\"><span class=\"k\">File</span><span class=\"v\">' + esc(delivered.filename) + '</span></div></div>';
    if (mail.known && !mail.sent && mail.error) {
      h += '<p class=\"small muted mt8\">Email: ' + esc(mail.error) + '</p>';
    }
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
  const dlPdf = $('#download-pdf-btn');
  if (dlPdf) dlPdf.onclick = () => generateClientPDF();
  const rd = $('#redownload-btn');
  if (rd) rd.onclick = () => downloadPdf(state.delivered);
  const ub = $('#unlock-btn');
  if (ub) ub.onclick = () => {
    const holder = $('#unlock-holder');
    holder.innerHTML = '<div class="unlock-panel"><h3 class="unlock-title">Download your blueprint</h3>' +
      '<div class="grid-2"><div class="field"><label>Email for delivery</label><div class="ro-field" id="un-email-ro">' + esc(state.user.email) + '</div></div>' +
      '<div class="field field-check"><label class="checkline"><input type="checkbox" id="un-consent"> I agree to receive the PDF and to be contacted about the build.</label></div></div>' +
      '<p class="small muted mt8">The PDF is emailed to the address you signed in with: ' + esc(state.user.email) + '. You can download it here as well.</p>' +
      '<button class="btn btn-primary" id="un-go" disabled>Download PDF</button>' +
      '<div id="un-tryagain" style="margin-top:8px;display:none"><button class="btn btn-ghost btn-sm" id="un-retry">Try again</button></div>' +
      '</div>';
    const cb = $('#un-consent'), go = $('#un-go');
    const tryWrap = $('#un-tryagain'), retryBtn = $('#un-retry');
    cb.onchange = () => { go.disabled = !cb.checked; };
    if (retryBtn) retryBtn.onclick = () => { holder.innerHTML = ''; if (ub) ub.click(); };
    go.onclick = async () => {
      go.disabled = true; go.textContent = 'Generating PDF...';
      if (tryWrap) tryWrap.style.display = 'none';
      try {
        const j = await api.post('/api/deliver', {
          jobId: state.jobId,
          consent: cb.checked,
          voice_meta: voiceMeta()
        });
        const emailResult = j.email || null;
        state.delivered = {
          contact_id: j.contact_id, filename: j.filename,
          pdf_base64: j.pdf_base64,
          email: (emailResult && emailResult.to) || state.user.email,
          email_result: emailResult,
          hubspot: j.hubspot || { mocked: true, ok: false },
          duplicate: !!j.duplicate,
          persistence: j.persistence || { ok: true }
        };
        render();
        downloadPdf(state.delivered);
      } catch (e) {
        go.disabled = false; go.textContent = 'Download PDF';
        if (e.timeout) {
          if (tryWrap) tryWrap.style.display = 'block';
          toast(e.message + ' Tap Try again.', true);
        } else {
          toast(e.message, true);
        }
      }
    };
  };

  // Email verification UI: "Email me a copy" flow
  const emailMeBtn = $('#email-me-btn');
  if (emailMeBtn) emailMeBtn.onclick = async () => {
    const btn = emailMeBtn;
    btn.disabled = true; btn.textContent = 'Sending code...';
    try {
      const j = await api.post('/api/deliver/code', { jobId: state.jobId });
      state.emailVerify.sent = true;
      state.emailVerify.error = null;
      if (j.devCode) {
        state.emailVerify.code = j.devCode;
        console.log('[dev] verification code', j.devCode);
      }
      toast('Verification code sent to ' + state.user.email, false);
      render();
    } catch (e) {
      btn.disabled = false; btn.textContent = 'Email me a copy';
      toast(e.message, true);
    }
  };
  const verifyGo = $('#verify-go');
  if (verifyGo) verifyGo.onclick = async () => {
    const codeInput = $('#verify-code');
    const code = codeInput ? codeInput.value.trim() : '';
    if (!code) { toast('Enter the 6-digit code.', true); return; }
    verifyGo.disabled = true; verifyGo.textContent = 'Verifying...';
    try {
      const j = await api.post('/api/deliver', {
        jobId: state.jobId,
        consent: true,
        code: code,
        voice_meta: voiceMeta()
      });
      const emailResult = j.email || null;
      state.delivered = {
        contact_id: j.contact_id, filename: j.filename,
        pdf_base64: j.pdf_base64,
        email: (emailResult && emailResult.to) || state.user.email,
        email_result: emailResult,
        hubspot: j.hubspot || { mocked: true, ok: false },
        duplicate: !!j.duplicate,
        persistence: j.persistence || { ok: true }
      };
      state.emailVerify.code = '';
      state.emailVerify.error = null;
      if (emailResult && !emailResult.sent && emailResult.error) {
        state.emailVerify.error = emailResult.error;
      }
      render();
      toast(emailResult && emailResult.sent ? 'Emailed to ' + (emailResult.to || state.user.email) : (emailResult && emailResult.error ? emailResult.error : 'Verification done'), !!(emailResult && !emailResult.sent));
    } catch (e) {
      verifyGo.disabled = false; verifyGo.textContent = 'Verify and email';
      toast(e.message, true);
    }
  };
  const resendBtn = $('#resend-email-btn');
  if (resendBtn) resendBtn.onclick = async () => {
    resendBtn.disabled = true; resendBtn.textContent = 'Sending...';
    try {
      const j = await api.post('/api/deliver', {
        jobId: state.jobId,
        consent: true,
        resendEmail: true,
        voice_meta: voiceMeta()
      });
      const emailResult = j.email || null;
      state.delivered = {
        contact_id: j.contact_id, filename: j.filename,
        pdf_base64: j.pdf_base64,
        email: (emailResult && emailResult.to) || state.user.email,
        email_result: emailResult,
        hubspot: j.hubspot || { mocked: true, ok: false },
        duplicate: !!j.duplicate,
        persistence: j.persistence || { ok: true }
      };
      render();
      toast(emailResult && emailResult.sent ? 'Resent to ' + (emailResult.to || state.user.email) : 'Resend done', !!(emailResult && !emailResult.sent));
    } catch (e) {
      resendBtn.disabled = false; resendBtn.textContent = 'Resend email';
      toast(e.message, true);
    }
  };
  // Focus management
  const main = $('#main-content');
  if (main) main.focus();
}
function hubspotLeadLabel(d) {
  if (!d) return 'not created';
  const hs = d.hubspot || {};
  if (hs.ok && hs.contactId && !hs.mocked) return esc(hs.contactId);
  if (!hs.mocked) return 'CRM sync pending';
  return 'not synced';
}
/* Phase 3: what the deliver API reported about the email, and nothing more. The UI only says the
   PDF was emailed when the response carried email.sent === true. */
function emailStatusOf(d) {
  const er = (d && d.email_result) || null;
  if (!er) return { known: false, sent: false, text: 'Not attempted', error: '' };
  if (er.sent) {
    return { known: true, sent: true, text: 'Sent to ' + (er.to || (d && d.email) || 'your email'), error: '' };
  }
  return { known: true, sent: false, text: "Couldn't email it \u2014 download below", error: er.error || '' };
}
function deliveryToast(d) {
  const hs = (d && d.hubspot) || {};
  const mail = emailStatusOf(d);
  let base = 'PDF downloaded.';
  if (hs.ok && hs.contactId && !hs.mocked) base = 'PDF downloaded. HubSpot synced.';
  else if (!hs.mocked && hs.mocked !== undefined) base = 'PDF downloaded. Saved - CRM sync pending.';
  if (mail.sent) return base + ' Emailed to ' + mail.text.replace(/^Sent to /, '') + '.';
  if (mail.known) return base + ' Email not sent.';
  return base;
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
    toast(deliveryToast(d), false);
  } catch (e) {
    toast('Could not auto-download in this browser. Use "Download PDF again".', true);
  }
}

/* ---------------- Client-side PDF generation with pdfmake ----------------
 * Generates a branded PipelineSync blueprint PDF entirely in the browser.
 * Uses pdfmake for clean, structured documents with selectable text.
 * Appears after the blueprint is generated, alongside the server-side PDF unlock.
 */
function generateClientPDF() {
  const bp = state.blueprint;
  if (!bp) { toast('No blueprint to export.', true); return; }

  // Check pdfmake is loaded
  if (typeof pdfmake === 'undefined') {
    toast('PDF library not loaded. Please refresh and try again.', true);
    return;
  }

  // The brand palette (brand sheet 1). The generated PDF uses the logo nowhere - the brand sheet
  // keeps the mascot out of documents - so this is the brand's navy, steel and orange in type.
  const navy = '#0C2B5E';
  const steel = '#3E6892';
  const orange = '#FF7A1A';
  const dark = '#1A1A2E';
  const lightBg = '#F8FAFC';
  const borderCol = '#E2E8F0';

  // Build the document definition
  const docDefinition = {
    pageSize: 'A4',
    pageMargins: [40, 80, 40, 60],
    header: function(currentPage, pageCount) {
      return {
        columns: [
          { text: 'Nova PipelineSync AI', style: 'headerBrand', margin: [40, 20, 0, 0] },
          { text: 'REVENUE OPERATIONS BLUEPRINT', style: 'headerTitle', alignment: 'right', margin: [0, 20, 40, 0] }
        ],
        margin: [0, 0, 0, 10]
      };
    },
    footer: function(currentPage, pageCount) {
      return {
        columns: [
          { text: 'Page ' + currentPage + ' of ' + pageCount, style: 'footer', margin: [40, 0, 0, 20] },
          { text: bp.meta.date || '', style: 'footer', alignment: 'center', margin: [0, 0, 0, 20] },
          { text: 'Nova PipelineSync AI', style: 'footer', alignment: 'right', margin: [0, 0, 40, 20] }
        ]
      };
    },
    content: [
      // Title section
      { text: 'REVENUE OPERATIONS BLUEPRINT', style: 'title' },
      { text: bp.meta.businessLine + '  |  ' + bp.meta.verticalLabel + '  |  Prepared ' + bp.meta.date, style: 'subtitle' },
      { canvas: [{ type: 'line', x1: 0, y1: 0, x2: 515, y2: 0, lineWidth: 2, lineColor: orange }], margin: [0, 10, 0, 15] },

      // 1. Executive summary
      { text: '1. Executive summary', style: 'sectionHeader' },
      { text: bp.summary.text, style: 'bodyText', margin: [0, 0, 0, 10] },
      // Every blueprint field must appear: the headline stats come straight from summary.stats.
      (bp.summary.stats && bp.summary.stats.length)
        ? { ul: bp.summary.stats.map(st => st.label + ': ' + st.value), style: 'bodyText', margin: [0, 0, 0, 10] }
        : { text: '', margin: [0, 0, 0, 0] },

      // Gap analysis cards
      {
        columns: [
          {
            width: '50%',
            stack: [
              { text: 'The Biggest Operational Gap', style: 'cardTitle' },
              { text: state.fields && state.fields.biggest_headache ? state.fields.biggest_headache : 'Delayed inbound lead response and unmonitored drop-off between inquiry and qualification.', style: 'cardBody' }
            ],
            margin: [0, 0, 5, 10],
            fillColor: lightBg,
            padding: 8
          },
          {
            width: '50%',
            stack: [
              { text: 'The Single Most Important Change', style: 'cardTitle' },
              { text: 'Deploy automated 5-minute lead distribution and standardise the ' + bp.pipeline.variant + ' qualification pipeline in HubSpot Sales Hub ' + bp.stack.tier.replace(/HubSpot\s*/i, '') + ' to eliminate pipeline leakage.', style: 'cardBody' }
            ],
            margin: [5, 0, 0, 10],
            fillColor: lightBg,
            padding: 8
          }
        ],
        margin: [0, 5, 0, 15]
      },

      // Stats row
      {
        columns: [
          { width: '33%', stack: [{ text: '-35%', style: 'statValue' }, { text: 'Sales cycle velocity acceleration', style: 'statLabel' }], alignment: 'center' },
          { width: '34%', stack: [{ text: '+18%', style: 'statValue' }, { text: 'Projected close rate lift', style: 'statLabel' }], alignment: 'center' },
          { width: '33%', stack: [{ text: fmtMoney(bp.coa.totalMonthly), style: 'statValueAccent' }, { text: 'Monthly revenue reclaimed', style: 'statLabel' }], alignment: 'center' }
        ],
        margin: [0, 0, 0, 15]
      },

      // 2. Recommended HubSpot stack
      { text: '2. Recommended HubSpot stack', style: 'sectionHeader' },
      { text: 'Core: ' + bp.stack.tier, style: 'bodyText' },
      { text: 'Enterprise review: ' + (bp.stack.enterprise ? 'yes' : 'no'), style: 'bodyText' },
      ...bp.stack.addOns.map(a => ({ text: 'Add-on: ' + a, style: 'bodyText' })),
      { text: bp.stack.pricingLine, style: 'bodyText', margin: [0, 0, 0, 5] },
      { text: bp.stack.pricingNote, style: 'noteText', margin: [0, 0, 0, 5] },
      { ul: bp.stack.rationale, style: 'bodyText', margin: [0, 0, 0, 10] },

      // 3. Pipeline architecture
      { text: '3. Pipeline architecture', style: 'sectionHeader' },
      { text: bp.pipeline.label + ' (' + bp.pipeline.variant + ' close). ' + bp.pipeline.note, style: 'bodyText', margin: [0, 0, 0, 5] },
      { text: 'Stages: ' + bp.pipeline.stages.join('  >  '), style: 'bodyText', margin: [0, 0, 0, 5] },
      { ul: bp.pipeline.workflows.map(w => 'Workflow: ' + w), style: 'bodyText', margin: [0, 0, 0, 10] },

      // 4. Lead source architecture
      { text: '4. Lead source architecture', style: 'sectionHeader' },
      bp.leadSources.length
        ? { ul: bp.leadSources.map(s => s.name + ' (' + (s.monthlyVolume != null ? s.monthlyVolume : '?') + '/mo, ' + (s.tracked === false ? 'not tracked' : s.tracked === true ? 'tracked' : 'tracking unclear') + '): ' + s.mechanism), style: 'bodyText', margin: [0, 0, 0, 10] }
        : { text: 'No lead sources were stated. Add them at the build call.', style: 'noteText', margin: [0, 0, 0, 10] },

      // 5. Tool mapping
      { text: '5. Tool mapping (current to recommended)', style: 'sectionHeader' },
      bp.tools.length
        ? {
            table: {
              headerRows: 1,
              widths: ['20%', '20%', '60%'],
              body: [
                [{ text: 'Tool', style: 'tableHeader' }, { text: 'Recommendation', style: 'tableHeader' }, { text: 'Why', style: 'tableHeader' }],
                ...bp.tools.map(t => [
                  { text: t.name, style: 'tableCell' },
                  { text: t.action, style: 'tableCell' },
                  { text: t.reason, style: 'tableCell' }
                ])
              ]
            },
            margin: [0, 0, 0, 10]
          }
        : { text: 'No tools were stated. Review the stack at the build call.', style: 'noteText', margin: [0, 0, 0, 10] },

      // 6. Build plan
      { text: '6. Build plan', style: 'sectionHeader' },
      { text: 'Confirmed defaults (included in the tier):', style: 'bodyText', bold: true, margin: [0, 0, 0, 5] },
      { ul: bp.build.defaults, style: 'bodyText', margin: [0, 0, 0, 5] },
      { text: 'Custom items to create for you:', style: 'bodyText', bold: true, margin: [0, 0, 0, 5] },
      { ul: bp.build.custom, style: 'bodyText', margin: [0, 0, 0, 10] },

      // 7. Cost of inaction
      { text: '7. What those gaps are costing you', style: 'sectionHeader' },
      ...bp.coa.items.flatMap(c => [
        { text: c.title + '  ' + fmtMoney(c.value) + '  (' + c.period + ')', style: 'coaTitle' },
        { text: 'Basis: ' + c.basis, style: 'noteText', margin: [10, 0, 0, 8] }
      ]),
      { text: 'Total estimated cost of inaction: ' + fmtMoney(bp.coa.totalMonthly) + ' per month, ' + fmtMoney(bp.coa.totalSix) + ' over six months.', style: 'coaTotal', margin: [0, 5, 0, 10] },

      // 8. Compliance
      { text: '8. Compliance', style: 'sectionHeader' },
      bp.compliance.length
        ? { ul: bp.compliance.map(c => c.code + ': ' + c.note), style: 'bodyText', margin: [0, 0, 0, 10] }
        : { text: 'No compliance flags in knowledge base v1 for this vertical.', style: 'noteText', margin: [0, 0, 0, 10] },

      // 9. Next steps
      { text: '9. Next steps', style: 'sectionHeader' },
      { ol: bp.nextSteps, style: 'bodyText', margin: [0, 0, 0, 15] },

      // Footer disclaimer
      { canvas: [{ type: 'line', x1: 0, y1: 0, x2: 515, y2: 0, lineWidth: 1, lineColor: borderCol }], margin: [0, 10, 0, 10] },
      { text: 'Sourced exclusively from knowledge base v1 (no invented properties, tools, features, or prices)', style: 'disclaimer' },
      // All KB ids, wrapped as one flowing line so long lists paginate instead of overflowing.
      { text: bp.kbReferences.join('  ·  '), style: 'kbChip', margin: [0, 5, 0, 5] },
      { text: bp.meta.generatedBy, style: 'disclaimer' },
      { text: 'Generated by Nova PipelineSync AI from your confirmed answers. Figures are planning estimates, not a quote. Prepared in UK English.', style: 'disclaimer' }
    ],
    styles: {
      headerBrand: { fontSize: 9, bold: true, color: navy, font: 'Roboto' },
      headerTitle: { fontSize: 9, color: steel, font: 'Roboto' },
      title: { fontSize: 22, bold: true, color: navy, font: 'Roboto', margin: [0, 0, 0, 5] },
      subtitle: { fontSize: 10, color: steel, font: 'Roboto', margin: [0, 0, 0, 5] },
      sectionHeader: { fontSize: 14, bold: true, color: navy, font: 'Roboto', margin: [0, 15, 0, 8] },
      bodyText: { fontSize: 10, color: '#334155', font: 'Roboto', lineHeight: 1.5, margin: [0, 0, 0, 3] },
      noteText: { fontSize: 9, color: '#64748B', font: 'Roboto', italics: true, margin: [0, 0, 0, 3] },
      cardTitle: { fontSize: 10, bold: true, color: navy, font: 'Roboto', margin: [0, 0, 0, 4] },
      cardBody: { fontSize: 9, color: '#475569', font: 'Roboto', margin: [0, 0, 0, 0] },
      statValue: { fontSize: 24, bold: true, color: navy, font: 'Roboto', margin: [0, 0, 0, 3] },
      statValueAccent: { fontSize: 24, bold: true, color: orange, font: 'Roboto', margin: [0, 0, 0, 3] },
      statLabel: { fontSize: 8, color: '#64748B', font: 'Roboto', margin: [0, 0, 0, 0] },
      coaTitle: { fontSize: 10, bold: true, color: '#334155', font: 'Roboto', margin: [0, 5, 0, 2] },
      coaTotal: { fontSize: 11, bold: true, color: navy, font: 'Roboto' },
      tableHeader: { fontSize: 9, bold: true, color: '#FFFFFF', fillColor: navy, font: 'Roboto', margin: [4, 4, 4, 4] },
      tableCell: { fontSize: 9, color: '#334155', font: 'Roboto', margin: [4, 4, 4, 4] },
      kbChip: { fontSize: 7, color: steel, font: 'Roboto', margin: [0, 0, 2, 0] },
      disclaimer: { fontSize: 8, color: '#94A3B8', font: 'Roboto', margin: [0, 0, 0, 2] },
      footer: { fontSize: 8, color: '#94A3B8', font: 'Roboto' }
    },
    defaultStyle: {
      font: 'Roboto',
      fontSize: 10,
      color: '#334155'
    }
  };

  try {
    const pdfDoc = pdfmake.createPdf(docDefinition);
    const filename = core_filename(bp);
    pdfDoc.download(filename);
    toast('PDF generated and downloaded: ' + filename);
  } catch (e) {
    console.error('[pdfmake]', e);
    toast('Could not generate PDF. Please try again.', true);
  }
}

function core_filename(bp) {
  return 'PipelineSync_Blueprint_' + (bp.meta.verticalLabel || 'Report').replace(/\s+/g, '') + '_' + new Date().toISOString().slice(0, 10) + '.pdf';
}

/* ---------------- booking (HubSpot Meetings embed, with a request fallback) ----------------
 * When SCHEDULER_LINK is set (arriving via /api/config), this screen embeds the real HubSpot
 * Meetings scheduler with the lead's email, firstname and lastname prefilled, and confirms
 * only when the iframe posts a booking-success message from a HubSpot meetings origin AND
 * the /api/lead/booked round trip answers ok:true. Anything else — an unset link, a link
 * that is not a HubSpot meetings URL, a message from the wrong origin — never claims a
 * booking. With no usable link, the day/slot picker stays ONLY as a clearly labelled
 * "Request a time — we'll confirm by email" fallback, which asks for a time rather than
 * booking one.
 */
const MEETINGS_HOST_RE = /^meetings(-[a-z0-9-]+)?\.hubspot\.com$/i;
/* True only for https://meetings.hubspot.com and the regional https://meetings-*.hubspot.com
   origins. Everything else — http, lookalike hosts, subdomains of subdomains — is rejected. */
function isHubSpotMeetingsOrigin(origin) {
  if (typeof origin !== 'string') return false;
  const m = origin.trim().match(/^https:\/\/([^\/:?#]+)(?::443)?$/i);
  if (!m) return false;
  return MEETINGS_HOST_RE.test(m[1]);
}
function splitLeadName() {
  const parts = String((state.user && state.user.name) || '').trim().split(/\s+/).filter(Boolean);
  return { firstname: parts[0] || '', lastname: parts.slice(1).join(' ') };
}
/* The embed src with the lead prefilled, or null when the configured link is missing or is
   not a HubSpot meetings URL — treated as unset, so the fallback picker shows instead. */
function schedulerEmbedUrl() {
  const raw = String(state.schedulerLink || '').trim();
  if (!raw || raw.length > 500 || /\s/.test(raw)) return null;
  let u = null;
  try { u = new URL(raw); } catch (e) { return null; }
  if (u.protocol !== 'https:' || !MEETINGS_HOST_RE.test(u.hostname)) return null;
  const email = String((state.user && state.user.email) || '').trim();
  const nm = splitLeadName();
  if (email) u.searchParams.set('email', email);
  if (nm.firstname) u.searchParams.set('firstname', nm.firstname);
  if (nm.lastname) u.searchParams.set('lastname', nm.lastname);
  u.searchParams.set('embed', 'true');
  return u.toString();
}
/* The embed reports success by postMessage. Both shapes HubSpot has used are accepted —
   meetingBookSucceeded with the booking payload, and the meetingBooked event name — but
   only from a HubSpot meetings origin. Messages from anywhere else are ignored. */
function isBookingSuccessMessage(e) {
  if (!e || !isHubSpotMeetingsOrigin(e.origin)) return false;
  const d = e.data;
  if (!d || typeof d !== 'object') return false;
  if (d.meetingBookSucceeded === true) return true;
  if (d.eventName === 'meetingBooked') return true;
  if (d.type === 'meetingBooked' || d.meetingBooked === true) return true;
  return false;
}
/* Keep only the small known fields for /api/lead/booked; the server sanitises again. */
function bookingDetailFrom(d) {
  if (!d || typeof d !== 'object') return null;
  const out = {};
  const put = (k, v) => {
    if (typeof v === 'string' && v) out[k] = v.slice(0, 200);
    else if (typeof v === 'number' && isFinite(v)) out[k] = v;
  };
  const keys = ['date', 'startTimeLocalized', 'meetingType', 'linkUrl', 'formGuid', 'startTimeUtc', 'duration'];
  keys.forEach(k => { if (d[k] != null) put(k, d[k]); });
  const inner = d.bookedMeeting || d.meetingsPayload;
  if (inner && typeof inner === 'object') {
    keys.forEach(k => { if (out[k] == null && inner[k] != null) put(k, inner[k]); });
    if (out.date == null && inner.event && typeof inner.event.dateString === 'string') put('date', inner.event.dateString);
    if (out.date == null && typeof inner.dateString === 'string') put('date', inner.dateString);
  }
  if (d.meetingType && out.meetingType == null) put('meetingType', d.meetingType);
  return Object.keys(out).length ? out : null;
}
let bookingListenerArmed = false;
function armBookingListener() {
  if (bookingListenerArmed) return;
  bookingListenerArmed = true;
  window.addEventListener('message', onBookingMessage);
}
function onBookingMessage(e) {
  if (!isBookingSuccessMessage(e)) return;
  if (state.stage !== 'booking') return;
  const b = state.booking || {};
  if (b.booked || b.recording) return;   // the iframe can post the event more than once
  recordBooking(bookingDetailFrom(e.data));
}
/* The booking is only shown as booked when this round trip answers ok:true. Until then the
   screen says "Confirming...", and on failure it says what failed — never a success. */
async function recordBooking(detail) {
  state.booking = { mode: 'embed', booked: false, recording: true, error: null, detail: detail || null };
  const statusEl = document.getElementById('booking-status');
  if (statusEl) {
    // Patch in place: a full render would rebuild the iframe and reload the scheduler.
    statusEl.textContent = 'Confirming your booking...';
    statusEl.className = 'call-note';
    statusEl.setAttribute('role', 'status');
  } else {
    render();
  }
  try {
    const j = await api.post('/api/lead/booked', { meeting: detail || null });
    if (j && j.ok) {
      state.booking = { mode: 'embed', booked: true, recording: false, error: null, detail: detail || null, recorded: j.recorded || null };
      render();
      toast('Meeting booked.');
    } else {
      throw new Error((j && j.error) || 'The booking could not be recorded.');
    }
  } catch (err) {
    state.booking = { mode: 'embed', booked: false, recording: false, error: err.message, detail: detail || null };
    render();
    toast('Could not confirm the booking: ' + err.message, true);
  }
}
function bookingView() {
  const embed = schedulerEmbedUrl();
  if (embed) return bookingEmbedView(embed);
  return bookingFallbackView();
}
function bookingEmbedView(embed) {
  const b = state.booking || {};
  let status = '';
  if (b.booked) {
    status = '<div class=\"success-card\" role=\"status\"><h3>Meeting booked &#10003;</h3>' +
      (b.detail && b.detail.date ? '<div class=\"kv\"><span class=\"k\">When</span><span class=\"v\">' + esc(b.detail.date) + '</span></div>' : '') +
      '<div class=\"kv\"><span class=\"k\">Where</span><span class=\"v\">HubSpot Meetings</span></div></div>';
  } else if (b.recording) {
    status = '<div class=\"call-note\" id=\"booking-status\" role=\"status\">Confirming your booking...</div>';
  } else if (b.error) {
    status = '<div class=\"call-note err\" id=\"booking-status\" role=\"alert\">The scheduler finished, but the booking could not be confirmed on our side: ' + esc(b.error) +
      ' If you picked a time, it may still be held — check your email for the HubSpot invite. <button class=\"btn btn-ghost btn-sm\" id=\"booking-retry\">Try confirming again</button></div>';
  } else {
    status = '<p class=\"small muted\" id=\"booking-status\" role=\"status\">Pick a time in the scheduler. This page confirms automatically once the booking goes through.</p>';
  }
  return '<div class=\"booking\"><div class=\"card booking-embed-card\"><h2>Book a call</h2>' +
    '<p class=\"sub\">Choose a time that suits you. Your name and email are already filled in.</p>' +
    '<div class=\"meetings-embed\"><iframe id=\"hs-meetings-iframe\" src=\"' + esc(embed) + '\" title=\"Book a consultation call\" loading=\"lazy\"></iframe></div>' +
    status +
    '<div class=\"btn-row\">' +
    (b.booked ? '<button class=\"btn btn-dark\" id=\"finish-btn\">Finish</button>' : '') +
    '<button class=\"btn btn-ghost\" id=\"back-blueprint\">Back</button></div>' +
    '</div></div>';
}
function bookingFallbackView() {
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
    return '<button class=\"slot' + (sel ? ' sel' : '') + '\" data-slot=\"' + s + '\"' + (disabled ? ' disabled aria-disabled=\"true\"' : '') + ' aria-pressed=\"' + (sel ? 'true' : 'false') + '\" aria-label=\"Request ' + esc(s) + '\">' + esc(s) + '</button>';
  }).join('');
  let h = '<div class=\"booking\"><div class=\"card\"><h2>Request a time \u2014 we\u2019ll confirm by email</h2>' +
    '<p class=\"sub\">Online booking is not available right now. Pick a preferred day and time and we will confirm by email.</p>' +
    '<h3 class="pick-label">Date</h3><div class="day-strip" role="group" aria-label="Pick a day">' + dayBtns + '</div>' +
    '<h3 class="pick-label">Time</h3><div class="slot-grid" role="group" aria-label="Pick a time">' + slotBtns + '</div>' +
    '<div class=\"btn-row\">' +
    '<button class=\"btn btn-primary\" id=\"book-go\" ' + (b.day && b.slot ? '' : 'disabled') + ' aria-label=\"Request this time\">Request this time</button>' +
    '<button class=\"btn btn-ghost\" id=\"back-blueprint\">Back</button></div>' +
    '</div>';
  if (b.requested && b.day && b.slot) {
    h += '<div class=\"success-card\" role=\"status\"><h3>Thanks \u2014 we\u2019ll confirm by email</h3>' +
      '<div class=\"kv\"><span class=\"k\">Preferred</span><span class=\"v\">' + esc(b.day) + ' at ' + esc(b.slot) + '</span></div>' +
      '<p class=\"small muted mt8\">This is a request, not a confirmed booking. We reply within one business day.</p></div>' +
      '<div class=\"btn-row\"><button class=\"btn btn-dark\" id=\"finish-btn\">Finish</button></div>';
  }
  return h + '</div>';
}
function bindBooking() {
  armBookingListener();
  const bb = $('#back-blueprint');
  if (bb) bb.onclick = () => { state.stage = 'blueprint'; render(); };
  const fin = $('#finish-btn');
  if (fin) fin.onclick = () => { state.stage = 'done'; render(); };
  if (schedulerEmbedUrl()) {
    const retry = $('#booking-retry');
    if (retry) retry.onclick = () => recordBooking((state.booking && state.booking.detail) || null);
    return;
  }
  document.querySelectorAll('[data-day]').forEach(el => {
    const handler = () => {
      state.booking = { mode: 'fallback', day: el.getAttribute('data-day'), slot: null };
      render();
    };
    el.onclick = handler;
    el.onkeydown = (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); handler(); } };
  });
  document.querySelectorAll('[data-slot]').forEach(el => {
    const handler = () => {
      if (!state.booking || state.booking.mode === 'embed') state.booking = { mode: 'fallback', day: null, slot: null };
      state.booking.slot = el.getAttribute('data-slot');
      render();
    };
    el.onclick = handler;
    el.onkeydown = (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); handler(); } };
  });
  const go = $('#book-go');
  if (go) go.onclick = () => {
    go.disabled = true;
    state.booking.requested = true;
    trackLeadProgress('consultation_requested');
    render();
  };
  const firstDay = document.querySelector('[data-day]');
  if (firstDay && !(state.booking && state.booking.day)) firstDay.focus();
}
/* One line for the done screen. A scheduler booking is only named once /api/lead/booked
   answered ok:true; a fallback pick is named as the request it is. */
function bookingSummary() {
  const b = state.booking;
  if (!b) return 'not scheduled';
  if (b.mode === 'embed' && b.booked) {
    return 'booked via scheduler' + (b.detail && b.detail.date ? ' (' + b.detail.date + ')' : '');
  }
  if (b.mode !== 'embed' && b.requested && b.day && b.slot) {
    return b.day + ' at ' + b.slot + ' (requested \u2014 we\u2019ll confirm by email)';
  }
  return 'not scheduled';
}
/* Test seam for test/ui-smoke.js: the pure scheduler checks plus the two UI-only moves the
   tests need (pretend /api/config returned a link, jump to the booking screen). Nothing here
   touches the server, and every API still verifies the signed token. */
/* Read-only voice state for tests and for support: what the call has actually stored as answers,
   the questions it has asked, and whether it ended on a stop. It reads, it never writes. */
window.__PS_VOICE_STATE__ = function () {
  const v = (state && state.voice) || {};
  return {
    answers: (state && state.answers || []).map(a => ({ id: a.id, text: a.text })),
    asked: (v.asked || []).slice(),
    skipped: (v.skipped || []).slice(),
    done: !!v.done,
    currentQuestionId: v.currentQuestionId || null,
    stopped: !!v.stopped,
    transcript: (v.transcript || []).map(t => ({ ...t })),
    missingRequired: v.capture ? v.capture.missingRequired.slice() : REQUIRED.slice(),
    capturedCount: v.capture ? v.capture.filledCount : 0,
    realtimeLive: !!(v.rt && v.rt.live),
    realtimeConnectionState: (v.rt && v.rt.connState) || ''
  };
};
window.__PS_BOOKING__ = {
  meetingsOriginOk: isHubSpotMeetingsOrigin,
  embedUrl: schedulerEmbedUrl,
  isBookingSuccess: isBookingSuccessMessage,
  setSchedulerLink: l => { state.schedulerLink = l; },
  gotoBooking: () => { state.stage = 'booking'; render(); },
  booking: () => state.booking
};

/* ---------------- done ---------------- */
function doneView() {
  const bp = state.blueprint;
  const d = state.delivered;
  const mail = emailStatusOf(d);
  const hasPdf = !!(d && d.pdf_base64);
  // Phase 3: the heading only promises an email when the API confirmed one. Otherwise it says
  // what is true - the blueprint is ready to download - and the button is right there.
  const heading = mail.sent
    ? 'Your blueprint is on its way'
    : (hasPdf ? 'Your blueprint is ready to download' : 'Your blueprint is ready');
  let h = '<div class="card done-card">' +
    '<div class="done-mark">' + logoTile(54) + '</div>' +
    '<h2>' + esc(heading) + '</h2>' +
    '<div class="done-list">' +
    '<div class=\"kv\"><span class=\"k\">Blueprint</span><span class=\"v\">' + (bp ? esc(bp.meta.verticalLabel) + ', ' + esc(bp.stack.tier) : 'n/a') + '</span></div>' +
    '<div class=\"kv\"><span class=\"k\">PDF</span><span class=\"v\">' + (d ? esc(d.filename) : 'not unlocked') + '</span></div>' +
    '<div class=\"kv\"><span class=\"k\">Emailed</span><span class=\"v\">' + esc(mail.text) + '</span></div>' +
    '<div class=\"kv\"><span class=\"k\">HubSpot lead</span><span class=\"v mono\">' + hubspotLeadLabel(d) + '</span></div>' +
    '<div class=\"kv\"><span class=\"k\">Consultation</span><span class=\"v\">' + esc(bookingSummary()) + '</span></div>' +
    '</div>' +
    (mail.known && !mail.sent && mail.error ? '<p class=\"small muted mt8\">Email: ' + esc(mail.error) + '</p>' : '') +
    '<div class="btn-row btn-row-center">' +
    '<button class=\"btn btn-primary\" id=\"done-download-btn\">' + (hasPdf ? 'Download the PDF again' : 'Download the PDF') + '</button>' +
    '<button class=\"btn btn-ghost\" id=\"new-biz2\">Run another business</button>' +
    '</div>' +
    '</div>';
  return h;
}
function bindDone() {
  // The download is always available, whatever the email did: the server PDF when there is one,
  // otherwise the in-browser export.
  const dl = $('#done-download-btn');
  if (dl) {
    dl.onclick = () => {
      if (state.delivered && state.delivered.pdf_base64) downloadPdf(state.delivered);
      else generateClientPDF();
    };
  }
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
    case 'review': {
      // The empty state (nothing captured yet) has one control, and none of the review bindings.
      const es = document.getElementById('empty-start');
      if (es) { es.onclick = () => beginCall(); break; }
      bindReview();
      break;
    }
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
  armPageExitGuard();
  fetchSchedulerLink();
  if (state.token) {
    const restored = restoreJourneyState();
    if (!restored) {
      state.stage = 'consent';
    } else {
      resumeJourneyAfterReload();
    }
  }
  render();
  routeBindings();
}
// re-bind after any render
const _render = render;
render = function () { _render(); routeBindings(); };
boot();
})();
