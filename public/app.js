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
// Safe storage: the preview iframe can run sandboxed without allow-same-origin,
// where localStorage throws. Fall back to in-memory so the app still works.
const memStore = {};
const store = {
  get: k => { try { return window.localStorage.getItem(k); } catch (e) { return memStore[k] != null ? memStore[k] : null; } },
  set: (k, v) => { try { window.localStorage.setItem(k, v); } catch (e) { memStore[k] = v; } }
};

/* ---------------- interview (voice intake script stand-in) ---------------- */
const QUESTIONS = [
  { id: 'business', q: 'Hi, I am Alex from PipelineSync. Let us get to know your business. What do you do, and who do you sell to?', hint: 'One or two sentences is plenty. For example: "We install residential solar systems for homeowners in Ilocos."' },
  { id: 'products', q: 'What are the main products or services you sell, and what do they cost? If a sale needs something first, like a survey or an evaluation, tell me.', hint: 'For example: "Residential install at 1,200,000 pesos, and commercial at 4,500,000, and commercial needs a site survey first."' },
  { id: 'deal', q: 'Roughly, how big is a typical deal? And how many people take sales calls?', hint: 'For example: "About 1,500,000 a deal, and three reps take calls."' },
  { id: 'fulfilment', q: 'How many people handle fulfilment, and how do you deliver once a sale is made?', hint: 'For example: "Six people, and our own crew does the installs."' },
  { id: 'owner', q: 'Who owns marketing and operations at your company?', hint: 'A name and role works. Or just "me" if it is you.' },
  { id: 'close', q: 'How do most customers buy? Do you close in a single call, or is there usually a second call? Walk me through the process as it stands.', hint: 'For example: "Two calls. First we qualify and do the survey, then we present the proposal."' },
  { id: 'sources', q: 'Where do your leads come from right now, and roughly how many per month from each? Do you track those numbers?', hint: 'One per line works well. For example: "Google Ads about 25 a month, tracked" then "Walk-ins about 10 a month, not tracked."' },
  { id: 'capture', q: 'How do you capture leads today, and what tools or CRM do you use? If you are on HubSpot, which tier?', hint: 'For example: "They land in a spreadsheet, and I use HubSpot Starter plus WhatsApp."' },
  { id: 'volumes', q: 'How many leads do you get a month, and how many do you close? What is your close rate, and how long is a typical sales cycle?', hint: 'For example: "55 leads, I close 12, so about 22 percent, and three weeks from first call to signed."' },
  { id: 'spend', q: 'What do you spend per month on marketing, and what is your monthly software budget?', hint: 'For example: "80,000 on ads, about 15,000 on software."' },
  { id: 'headache', q: 'What is the biggest headache with sales or marketing right now?', hint: 'Be honest. That is where the blueprint earns its keep.' },
  { id: 'goal', q: 'Last one. Six months from now, what would make this a clear win?', hint: 'For example: "20 closed installs a month."' }
];

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
  qIndex: 0,
  answers: [],           // [{id, text}]
  fields: null,          // Section 7 contract
  blueprint: null,
  delivered: null,       // {contact_id, filename, pdf_url}
  booking: null,         // {day, slot}
  fieldStatus: {}        // live sidebar state
};
function saveAuth() {
  store.set('ps_token', state.token || '');
  store.set('ps_user', JSON.stringify(state.user || {}));
}
function resetJourney() {
  state.stage = 'consent'; state.qIndex = 0; state.answers = []; state.fields = null;
  state.blueprint = null; state.delivered = null; state.booking = null; state.fieldStatus = {};
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

/* ---------------- voice (Web Speech API stand-in for the OpenAI voice layer) ---------------- */
let rec = null, recActive = false;
function toggleMic() {
  const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
  if (!SR) { toast('Voice input is not supported in this browser. You can type instead.', true); return; }
  if (recActive) { try { rec.stop(); } catch (e) {} recActive = false; updateMicUI(); return; }
  try {
    rec = new SR();
    rec.lang = 'en-PH';
    rec.interimResults = true;
    rec.continuous = true;
    rec.onresult = e => {
      let t = '';
      for (const r of e.results) t += r[0].transcript;
      const inp = $('#intake-input');
      if (inp) inp.value = t;
    };
    rec.onend = () => { recActive = false; updateMicUI(); };
    rec.onerror = () => { recActive = false; updateMicUI(); };
    rec.start();
    recActive = true;
  } catch (e) {
    recActive = false;
    toast('Could not start the microphone. You can type instead.', true);
  }
  updateMicUI();
}
function updateMicUI() {
  const b = $('#mic-btn');
  if (b) b.className = 'icon-btn' + (recActive ? ' listening' : '');
}

/* ---------------- rendering ---------------- */
function render() {
  const app = $('#app');
  if (!state.token) { app.innerHTML = loginView(); return; }
  let h = topbar() + '<main class="main">' + steps();
  switch (state.stage) {
    case 'consent': h += consentView(); break;
    case 'intake': h += intakeView(); break;
    case 'extracting': h += loaderView('extracting'); break;
    case 'review': h += reviewView(); break;
    case 'generating': h += loaderView('generating'); break;
    case 'blueprint': h += blueprintView(); break;
    case 'booking': h += bookingView(); break;
    case 'done': h += doneView(); break;
  }
  h += '</main>' + footer();
  app.innerHTML = h;
  if (state.stage === 'intake') {
    const body = $('#chat-body');
    if (body) body.scrollTop = body.scrollHeight;
    updateMicUI();
  }
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
  return '<div class="footer"><span>Prototype build v0.1</span><span>AI, PDF, and CRM steps are simulated locally; in production these are Netlify functions calling OpenAI, Claude, and HubSpot, with Supabase for auth and data.</span><span>All keys live server-side, never in the browser.</span><a href="/dev/outbox" target="_blank" rel="noopener">HubSpot outbox (dev)</a></div>';
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
    '<div class="notice"><h4>AI disclaimer</h4><p>This product uses AI. Your spoken and written answers are processed by AI models (in production: OpenAI for the voice layer, Claude for extraction and drafting). AI output can contain errors. A human reviews every blueprint before it is used in a build. Nothing in your blueprint is legal, financial, or professional advice.</p></div>' +
    '<div class="notice"><h4>Privacy notice</h4><p>Your answers are stored in our database (Supabase) so we can build your blueprint, and a summary is sent to our CRM (HubSpot) so the right person can follow up. We do not sell your data. Voice audio is transcribed and not retained beyond the transcript. You can request deletion at any time by emailing privacy@pipelinesync.ai.</p></div>' +
    '<label class="checkline"><input type="checkbox" id="consent-cb"> I understand how my data is used, and I agree to continue.</label>' +
    '<div class="btn-row"><button class="btn btn-primary" id="consent-go" disabled>Start the discovery call</button></div>' +
    '</div>';
}

/* ---------------- intake ---------------- */
function intakeView() {
  let chat = '';
  state.answers.forEach(a => {
    const q = QUESTIONS.find(x => x.id === a.id);
    chat += '<div class="bubble ai">' + esc(q ? q.q : '') + '</div>';
    chat += '<div class="bubble user">' + (a.text ? esc(a.text) : '<span style="opacity:.65">(skipped, you can add it in the review step)</span>') + '</div>';
  });
  if (state.qIndex < QUESTIONS.length) {
    const q = QUESTIONS[state.qIndex];
    chat += '<div class="bubble ai">' + esc(q.q) + '<span class="hint">' + esc(q.hint) + '</span></div>';
  } else {
    chat += '<div class="bubble ai">That is everything I need. Sit tight while I structure your answers, and you will get a chance to correct anything I got wrong.</div>';
  }
  const done = state.qIndex >= QUESTIONS.length;
  const chips = Object.keys(FIELD_LABELS).map(k => {
    const st = state.fieldStatus[k] || 'pending';
    return '<div class="side-chip ' + st + '"><span>' + FIELD_LABELS[k] + '</span><span class="dot"></span></div>';
  }).join('');
  const personaOpts = Object.keys(PERSONAS).map(k => '<option value="' + k + '">' + PERSONAS[k].label + '</option>').join('');
  return '<div class="intake-wrap"><div class="chat">' +
    '<div class="chat-head"><div class="who"><div class="avatar">AI</div>AI discovery call</div>' +
    '<div class="progress">Question ' + Math.min(state.qIndex + 1, QUESTIONS.length) + ' of ' + QUESTIONS.length + '</div></div>' +
    '<div class="progressbar"><div style="width:' + Math.round((state.answers.length / QUESTIONS.length) * 100) + '%"></div></div>' +
    '<div class="chat-body" id="chat-body">' + chat + '</div>' +
    (done
      ? '<div class="chat-input"><button class="btn btn-primary" id="structure-btn" style="flex:1">Structure my answers</button></div>'
      : '<div class="chat-input"><textarea id="intake-input" placeholder="Type your answer, or tap the mic and speak..." rows="1"></textarea>' +
        '<button class="icon-btn" id="mic-btn" title="Speak your answer">&#127908;</button>' +
        '<button class="btn btn-primary" id="send-btn">Send</button>' +
        '<button class="btn btn-ghost" id="skip-btn" title="Answer this later; the review screen will prompt for it">Skip</button></div>') +
    '</div>' +
    '<div>' +
    '<div class="side-card"><h3>What we have captured</h3><div class="chip-col">' + chips + '</div>' +
    '<div class="persona"><label for="persona-sel">QA shortcut: load a demo business</label>' +
    '<select id="persona-sel"><option value="">Choose a vertical...</option>' + personaOpts + '</select>' +
    '<button class="btn btn-ghost btn-sm" id="persona-go" style="width:100%">Load demo answers</button>' +
    '<p class="hint" style="font-size:11.5px;color:var(--faint);margin-top:8px">Runs the four verticals from the QA checklist without a microphone.</p></div></div>' +
    '</div></div>';
}
async function refreshFieldStatus() {
  if (!state.answers.length) return;
  try {
    const j = await api.post('/api/extract', { answers: state.answers });
    const f = j.fields;
    const st = {};
    Object.keys(FIELD_LABELS).forEach(k => {
      const v = f[k];
      const empty = v === null || (Array.isArray(v) && !v.length) || v === '';
      st[k] = empty ? 'null' : 'filled';
    });
    state.fieldStatus = st;
    const chips = document.querySelectorAll('.side-chip');
    chips.forEach((c, i) => {
      const k = Object.keys(FIELD_LABELS)[i];
      if (k && st[k]) c.className = 'side-chip ' + st[k];
    });
  } catch (e) { /* non-fatal */ }
}
function sendAnswer(text, skip) {
  if (state.qIndex >= QUESTIONS.length) return;
  const q = QUESTIONS[state.qIndex];
  state.answers.push({ id: q.id, text: text || '' });
  state.qIndex++;
  render();
  refreshFieldStatus();
}
function bindIntake() {
  const send = () => {
    const inp = $('#intake-input');
    const t = (inp.value || '').trim();
    if (!t) return;
    if (recActive) { try { rec.stop(); } catch (e) {} recActive = false; }
    sendAnswer(t);
  };
  const sb = $('#send-btn'); if (sb) sb.onclick = send;
  const sk = $('#skip-btn'); if (sk) sk.onclick = () => sendAnswer('', true);
  const mic = $('#mic-btn'); if (mic) mic.onclick = toggleMic;
  const inp = $('#intake-input');
  if (inp) {
    inp.focus();
    inp.addEventListener('keydown', e => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(); } });
    inp.addEventListener('input', () => {
      inp.style.height = 'auto';
      inp.style.height = Math.min(inp.scrollHeight, 120) + 'px';
    });
  }
  const stb = $('#structure-btn');
  if (stb) stb.onclick = () => startExtraction();
  const pg = $('#persona-go');
  if (pg) pg.onclick = () => {
    const sel = $('#persona-sel').value;
    if (!sel) { toast('Pick a demo business first.', true); return; }
    const p = PERSONAS[sel];
    state.answers = QUESTIONS.map(q => ({ id: q.id, text: p.answers[q.id] || '' }));
    state.qIndex = QUESTIONS.length;
    toast('Loaded demo answers for ' + p.label + '. Review below.');
    render();
    refreshFieldStatus();
  };
}
async function startExtraction() {
  state.stage = 'extracting';
  render();
  const stepsEl = document.querySelectorAll('.lstep');
  const steps = ['Calling Claude (Prompt B) on the transcript', 'Mapping answers to the data contract', 'Flagging unstated values as null'];
  for (let i = 0; i < steps.length; i++) {
    if (stepsEl[i]) { stepsEl[i].className = 'lstep active'; }
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
          '<select data-key="' + cfg.k + '" data-type="select"' + (v == null ? ' data-nullsel="1"' : '') + '>' + (v == null ? '<option value="" selected>Not stated</option>' : '') + opts + '</select></div>';
      } else if (cfg.type === 'textarea') {
        h += '<div class="field' + (nullish ? ' is-null' : '') + ' review-full"><label>' + cfg.label + req + badge + '</label>' +
          '<textarea data-key="' + cfg.k + '" data-type="text">' + esc(v) + '</textarea></div>';
      } else {
        const ph = cfg.type === 'money' ? 'PHP amount' : cfg.type === 'number' ? 'Number' : 'Text';
        h += '<div class="field' + (nullish ? ' is-null' : '') + full + '"><label>' + cfg.label + req + badge + '</label>' +
          '<input data-key="' + cfg.k + '" data-type="' + (cfg.type === 'money' || cfg.type === 'number' ? 'number' : 'text') + '" value="' + esc(v) + '" placeholder="' + ph + '"></div>';
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
  let h = '<div class="card"><h2>Review and correct your answers</h2>' +
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
          blueprint: state.blueprint
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
      go.onclick = () => { state.stage = 'intake'; render(); };
      break;
    }
    case 'intake': bindIntake(); break;
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
