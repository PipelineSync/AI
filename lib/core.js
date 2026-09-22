'use strict';
/*
 * Shared core: knowledge base v1, extraction (Function A logic),
 * generation (Function B logic), PDF writer (Function C logic),
 * signed prototype tokens, and the HubSpot lead payload shape (Function D).
 *
 * Imported by BOTH:
 *   - server.js               (local dev: node server.js)
 *   - netlify/functions/*.js  (deployed: GitHub -> Netlify, no Supabase)
 *
 * Everything here is stateless, so it runs safely on serverless cold starts.
 *
 * SYNC SOURCE: docs/KB_AND_MASTER_PROMPT.md v1 is the single source of truth.
 * Last synced: 2026-09-18 — KB object below matches Section 1 of the MD verbatim.
 * Machine-readable copy: docs/KB.json
 * Master prompts: lib/prompts.js (PROMPT_A, PROMPT_B, INTAKE_PLAN, FAQ)
 * Voice master prompt: lib/voice.js (realtimeInstructions, buildMessages)
 */
const crypto = require('crypto');
let PROMPTS = null;
try { PROMPTS = require('./prompts'); } catch (e) { PROMPTS = null; }

/* ------------------------------------------------------------------ */
/* Knowledge base v1 (Supabase tables stand-in). The AI may only pick  */
/* from this. Every reference used by generate() is tagged with an id. */
/* ------------------------------------------------------------------ */
const KB = {
  version: 'v1',
  tiers: {
    floor: { name: 'Sales Hub Professional', id: 'KB-TIER-01', rule: 'Sales Hub Professional is the floor: the build requires workflows, and Starter cannot run them.' },
    enterprise: { minReps: 4, minCycleWeeks: 12, minLeads: 500, id: 'KB-TIER-02', rule: 'Recommend Enterprise when team size, cycle length, or lead volume reaches the top of the Professional band.' },
    marketing: { minSpend: 50000, minLeads: 300, id: 'KB-TIER-03', rule: 'Add Marketing Hub Professional when spend is at or above 50,000 a month, or volume at or above 300 leads a month.' },
    service: { id: 'KB-TIER-04', rule: 'Add Service Hub where the vertical recipe calls for front-desk ticketing or post-service follow-up.' },
    pricing: { perSeatUSD: 90, note: 'List price, USD per seat per month, from knowledge base v1. Regional and committed pricing varies. Confirm at the build call.' }
  },
  pipelines: {
    'one-call': { id: 'KB-PIPE-O1', label: 'Single-call pipeline', stages: ['New', 'Contacted', 'Qualified', 'Proposal', 'Closed Won', 'Closed Lost'], note: 'Every stage can advance on one conversation. Speed and first-response time are the differentiators.' },
    'two-call': { id: 'KB-PIPE-T2', label: 'Two-call pipeline', stages: ['New', 'Contacted', 'Qualified', 'Consult scheduled', 'Consult done', 'Proposal', 'Closed Won', 'Closed Lost'], note: 'First call qualifies, second call closes. The gap between calls is exactly where deals slip without workflows.' }
  },
  sourceMechanisms: [
    { match: ['website', 'web '], id: 'KB-SRC-WEB', text: 'Marketing Hub form on landing pages, with UTM tracking on all traffic' },
    { match: ['google ads', 'ads'], id: 'KB-SRC-PAY', text: 'Connected ad account with automated campaign, ad group, and contact reporting' },
    { match: ['facebook', 'meta', 'instagram', 'social'], id: 'KB-SRC-SOC', text: 'Social landing forms with UTM tracking. Point the best posts at a dedicated landing page' },
    { match: ['referral', 'word of mouth'], id: 'KB-SRC-REF', text: 'Referral landing form plus a shareable tracking link for every customer' },
    { match: ['walk', 'phone', 'call', 'counter'], id: 'KB-SRC-PHN', text: 'Mobile quick-capture form, plus a 30-day manual entry discipline while the habit forms' },
    { match: ['email'], id: 'KB-SRC-EM', text: 'Import with a source property, then a re-engagement sequence' }
  ],
  sourceMechanismDefault: { id: 'KB-SRC-DEF', text: 'HubSpot form with a source field and monthly volume tracking' },
  toolVariants: [
    ['hubspot', 'HubSpot'], ['salesforce', 'Salesforce'], ['zoho', 'Zoho CRM'], ['pipedrive', 'Pipedrive'],
    ['freshsales', 'Freshsales'], ['gohighlevel', 'GoHighLevel'], ['excel', 'Microsoft Excel'],
    ['google sheets', 'Google Sheets'], ['calendly', 'Calendly'], ['whatsapp', 'WhatsApp'],
    ['mailchimp', 'Mailchimp'], ['klaviyo', 'Klaviyo'], ['shopify', 'Shopify'], ['google ads', 'Google Ads'],
    ['google business profile', 'Google Business Profile'], ['zoom', 'Zoom'],
    ['meta ads', 'Meta Ads'], ['facebook ads', 'Meta Ads'], ['facebook', 'Meta Ads'], ['google', 'Google Ads']
  ],
  tools: {
    'HubSpot': { action: 'Upgrade', reason: 'You are on the entry tier. This build needs workflows, so Professional is the floor. Move up rather than restart.' },
    'Salesforce': { action: 'Replace', reason: 'Consolidate into HubSpot so the whole build sits in one system. Import objects, map fields, decommission after 30 days.' },
    'Zoho CRM': { action: 'Replace', reason: 'One system of record. Import, map, decommission after 30 days.' },
    'Pipedrive': { action: 'Replace', reason: 'Consolidate into HubSpot. Keep Pipedrive read-only for a month during the switch.' },
    'Freshsales': { action: 'Replace', reason: 'Consolidate into HubSpot so workflows and reporting live in one place.' },
    'GoHighLevel': { action: 'Replace', reason: 'Move contacts and conversations into HubSpot. Retire the sub-account after import.' },
    'Microsoft Excel': { action: 'Consolidate', reason: 'Move tracking into HubSpot objects and properties. Keep Excel for one-way reports while the habit forms.' },
    'Google Sheets': { action: 'Consolidate', reason: 'Move tracking into HubSpot. Share the new dashboards instead of the sheet.' },
    'Calendly': { action: 'Replace', reason: 'Use HubSpot Meetings so every booking creates a task and can trigger a workflow.' },
    'WhatsApp': { action: 'Keep', reason: 'Connect it to HubSpot so conversations attach to the right contact and deal.' },
    'Mailchimp': { action: 'Consolidate', reason: 'Move lists and email into Marketing Hub to end the double entry.' },
    'Klaviyo': { action: 'Keep or consolidate', reason: 'If e-commerce flows matter, keep and connect orders. Otherwise move to Marketing Hub.' },
    'Shopify': { action: 'Keep', reason: 'Connect orders to HubSpot so revenue sits beside the sales data.' },
    'Google Ads': { action: 'Keep', reason: 'Connect to HubSpot Ads for automated tracking and contact-level reporting.' },
    'Meta Ads': { action: 'Keep', reason: 'Connect to HubSpot Ads. Route the best-landing ads to a dedicated landing form.' },
    'Google Business Profile': { action: 'Keep', reason: 'Keep. Add the new tracking number and the booking link from the build.' },
    'Zoom': { action: 'Keep', reason: 'Keep. Link it into meetings and the pipeline for consult calls.' }
  },
  defaults: [
    'Contact, company, and deal objects',
    'Email sync for every sales seat',
    'Pipelines, deal stages, and basic dashboards',
    'Task management and reminders',
    'Sequences (included with Professional)'
  ],
  verticals: {
    solar: {
      label: 'Solar', serviceHub: false,
      workflows: ['Missed-call text-back within 5 minutes', '3-touch proposal follow-up over 14 days', 'Review-and-sign reminder 48 hours before the appointment'],
      compliance: [{ code: 'TCPA', id: 'KB-COMP-TCPA', note: 'Outbound follow-up to solar leads requires documented consent. Use opt-in forms, keep the consent timestamp, and honour do-not-contact requests immediately.' }]
    },
    medical: {
      label: 'Medical', serviceHub: true,
      serviceHubReason: 'A Service Hub seat for the front desk gives you ticketing, no-show tracking, and post-visit follow-up in one place.',
      workflows: ['Same-day reminder for the first visit', 'No-show win-back after 48 hours', '6-month recall for routine patients'],
      compliance: [{ code: 'HIPAA', id: 'KB-COMP-HIPAA', note: 'Patient data needs restricted access, field-level permissions, and a data processing addendum before any sync. In the Philippines, the Data Privacy Act of 2012 applies in parallel, so apply the stricter rule.' }]
    },
    home_services: {
      label: 'Home services', serviceHub: false,
      workflows: ['Missed-call text-back within 5 minutes', 'Quote-sent nudge after 3 days', 'Review request after job completion'],
      compliance: []
    },
    ecommerce: {
      label: 'E-commerce', serviceHub: false,
      workflows: ['Abandoned-cart sequence (2 touches)', 'Win-back for customers inactive 60 days', 'Post-purchase review request'],
      compliance: []
    },
    generic: {
      label: 'General business', serviceHub: false,
      workflows: ['Missed-call text-back within 5 minutes', '3-touch follow-up on open deals', 'Review request after closed-won'],
      compliance: []
    }
  }
};

/* ------------------------------------------------------------------ */
/* Small helpers                                                       */
/* ------------------------------------------------------------------ */
const WORDS = { one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10, eleven: 11, twelve: 12, thirteen: 13, fourteen: 14, fifteen: 15, twenty: 20, thirty: 30, forty: 40, fifty: 50, sixty: 60, eighty: 80 };
const WORD_RE = '\\d+|' + Object.keys(WORDS).join('|');

function num(v) {
  if (v == null || v === '') return null;
  const n = parseFloat(String(v).replace(/[^\d.]/g, ''));
  return isNaN(n) ? null : n;
}
function wordOrNum(tok) {
  if (tok == null) return null;
  const t = String(tok).replace(/,/g, '').toLowerCase();
  if (/^\d/.test(t)) return parseFloat(t);
  return WORDS[t] != null ? WORDS[t] : null;
}
function moneyMatches(text) {
  const out = [];
  const seenRaw = new Set();
  const seenPos = [];
  function overlaps(start, end) {
    for (const [s, e] of seenPos) {
      if (!(end <= s || start >= e)) return true;
    }
    return false;
  }
  function addMatch(value, raw, index, length) {
    const key = raw.toLowerCase().trim();
    if (seenRaw.has(key)) return;
    if (overlaps(index, index + length)) return;
    seenRaw.add(key);
    seenPos.push([index, index + length]);
    out.push({ value, raw });
  }
  let m;
  const re1 = /([₴$€])\s*([\d][\d,]*(?:\.\d+)?)(\s?(million|billion|k|thousand))?/gi;
  while ((m = re1.exec(text))) {
    let v = parseFloat(m[2].replace(/,/g, ''));
    const suf = (m[4] || '').toLowerCase();
    if (suf === 'k' || suf === 'thousand') v *= 1000;
    else if (suf === 'million') v *= 1e6;
    else if (suf === 'billion') v *= 1e9;
    addMatch(v, m[0], m.index, m[0].length);
  }
  const re2 = /\b([\d][\d,]*(?:\.\d+)?)\s?(million|billion|thousand|k)\b/gi;
  while ((m = re2.exec(text))) {
    let v = parseFloat(m[1].replace(/,/g, ''));
    const suf = m[2].toLowerCase();
    if (suf === 'k' || suf === 'thousand') v *= 1000;
    else if (suf === 'million') v *= 1e6;
    else v *= 1e9;
    addMatch(v, m[0], m.index, m[0].length);
  }
  const re3 = /\b([\d][\d,]*(?:\.\d+)?)\s?(?:pesos?|pounds?|dollars?)\b/gi;
  while ((m = re3.exec(text))) {
    const v = parseFloat(m[1].replace(/,/g, ''));
    addMatch(v, m[0], m.index, m[0].length);
  }
  return out;
}
function firstMoney(text) {
  const ms = moneyMatches(text);
  return ms.length ? ms[0].value : null;
}
function fmtMoney(v) {
  if (v == null || isNaN(v)) return 'n/a';
  const n = Math.round(v);
  return 'PHP ' + String(Math.abs(n)).replace(/\B(?=(\d{3})+(?!\d))/g, ',') + (n < 0 ? ' (credit)' : '');
}
function detectVertical(t0) {
  const t = (t0 || '').toLowerCase();
  if (/solar/.test(t)) return 'solar';
  if (/dental|dentist|clinic|medical|doctor|hospital|physio|health|wellness|therapy|vet|pharmacy/.test(t)) return 'medical';
  if (/plumb|hvac|aircon|air condition|roof|handyman|construction|remodel|pest control|cleaning|garden|landscap/.test(t)) return 'home_services';
  if (/online|shop|store|retail|ecommerce|e-commerce|subscription|coffee|clothing|fashion|dropship|marketplace/.test(t)) return 'ecommerce';
  return 'generic';
}
function detectTools(allText) {
  const found = [];
  for (const [variant, canonical] of KB.toolVariants) {
    const re = new RegExp('\\b' + variant.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
    if (re.test(allText) && !found.includes(canonical)) found.push(canonical);
  }
  return found;
}

/* ------------------------------------------------------------------ */
/* Prototype auth: HMAC-signed tokens (Supabase stand-in).             */
/* Stateless, so it works on Netlify serverless without a database.   */
/* ------------------------------------------------------------------ */
const TOKEN_TTL_MS = 7 * 24 * 60 * 60 * 1000;
/* The built-in development secret. It is public (it lives in this repo), so a deploy that falls
   back to it has forgeable session tokens - which for the voice layer means anyone could mint a
   token and spend OpenAI credit. tokenSecretStatus() exists so the paid realtime routes can refuse
   to open a session in that state. The value itself is never returned or logged. */
const DEV_TOKEN_SECRET = 'pipelinesync-prototype-dev-secret';
const MIN_TOKEN_SECRET = 16;
function isProductionEnv(env) {
  env = env || process.env;
  return env.CONTEXT === 'production' || env.NETLIFY === 'true' || env.NODE_ENV === 'production';
}
function tokenSecret() {
  const sec = process.env.PS_TOKEN_SECRET;
  if (!sec) {
    // In production (Netlify) we should fail hard; locally we allow dev secret with warning
    if (isProductionEnv(process.env)) {
      throw new Error('PS_TOKEN_SECRET is required in production');
    }
    return DEV_TOKEN_SECRET;
  }
  if (sec.length < MIN_TOKEN_SECRET) {
    console.warn('[security] PS_TOKEN_SECRET is too short, use at least ' + MIN_TOKEN_SECRET + ' chars');
  }
  return sec;
}
/* Readiness of the token-signing secret, for routes that must fail closed (the paid voice routes).
   Returns a reason string that is safe to show an operator: it names the problem, never the value.
   Production: missing, still-the-dev-fallback, or shorter than MIN_TOKEN_SECRET all fail closed.
   Local development keeps working (a missing/weak secret is reported as a warning, not a block),
   so `node server.js` and the test suite never need a production secret. */
function tokenSecretStatus(env) {
  env = env || process.env;
  const production = isProductionEnv(env);
  const sec = String(env.PS_TOKEN_SECRET || '').trim();
  if (!sec) {
    return production
      ? { ok: false, production, code: 'token-secret-missing', reason: 'PS_TOKEN_SECRET is not set on this server, so live voice sessions are refused. Set it in the host environment and redeploy.' }
      : { ok: true, production, code: 'dev-secret', reason: 'PS_TOKEN_SECRET is not set; local development is using the built-in development secret. Set it before deploying.' };
  }
  if (sec === DEV_TOKEN_SECRET) {
    return production
      ? { ok: false, production, code: 'token-secret-dev', reason: 'PS_TOKEN_SECRET is still the built-in development secret, so live voice sessions are refused. Set a long random string of your own and redeploy.' }
      : { ok: true, production, code: 'dev-secret', reason: 'PS_TOKEN_SECRET is the built-in development secret. Fine locally; replace it before deploying.' };
  }
  if (sec.length < MIN_TOKEN_SECRET) {
    return production
      ? { ok: false, production, code: 'token-secret-weak', reason: 'PS_TOKEN_SECRET is shorter than ' + MIN_TOKEN_SECRET + ' characters, so live voice sessions are refused. Set a longer random string and redeploy.' }
      : { ok: true, production, code: 'weak-secret', reason: 'PS_TOKEN_SECRET is shorter than ' + MIN_TOKEN_SECRET + ' characters. Use a longer random string before deploying.' };
  }
  return { ok: true, production, code: 'ok', reason: '' };
}
function signToken(payload) {
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const sig = crypto.createHmac('sha256', tokenSecret()).update(body).digest('base64url');
  return body + '.' + sig;
}
function verifyToken(token) {
  try {
    const [body, sig] = String(token || '').split('.');
    if (!body || !sig) return null;
    const expect = crypto.createHmac('sha256', tokenSecret()).update(body).digest('base64url');
    const a = Buffer.from(sig);
    const b = Buffer.from(expect);
    if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
    const payload = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
    if (!payload.email || payload.exp < Date.now()) return null;
    return payload;
  } catch (e) {
    return null;
  }
}
function loginNameFor(email) {
  return email.split('@')[0].replace(/[._-]+/g, ' ').replace(/\b\w/g, c => c.toUpperCase()).trim() || 'Business owner';
}
function newContactId() {
  return 'mock-' + crypto.randomBytes(4).toString('hex');
}

/* ------------------------------------------------------------------ */
/* The entry gate: name + email, not a password login.                 */
/*                                                                     */
/* There is no account to sign in to. The client types their name and  */
/* email, we hand back a signed session token, and the name becomes the */
/* one the AI interviewer uses on the discovery call (client_name on   */
/* /api/voice/turn) and the name on the HubSpot lead. Both mounts       */
/* (server.js and netlify/functions/start.js) validate through here so  */
/* the rules cannot drift apart.                                       */
/* ------------------------------------------------------------------ */
const NAME_MAX = 80;
const EMAIL_MAX = 254;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

/* Strip markup, control characters and runs of whitespace, then cap the length. The name is
   rendered into HTML, handed to the voice model as client_name, and pushed to the CRM, so it
   must never carry angle brackets (the browser escapes it too: this is defence in depth). */
function cleanName(raw) {
  return String(raw == null ? '' : raw)
    .replace(/[\u0000-\u001f\u007f]/g, ' ')
    .replace(/<[^<>]*>/g, ' ')   // drop anything that looks like a tag
    .replace(/[<>]/g, ' ')       // and any bracket left over
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, NAME_MAX)
    .trim();
}
function firstNameOf(name) {
  return String(cleanName(name) || '').split(' ')[0] || '';
}
function initialsOf(name) {
  const parts = String(cleanName(name) || '').split(' ').filter(Boolean);
  if (!parts.length) return '?';
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
}
function validateEntry(body) {
  const b = body || {};
  const name = cleanName(b.name);
  const email = String(b.email == null ? '' : b.email).trim().toLowerCase();
  if (!name) return { ok: false, error: 'Enter your name so the AI knows what to call you on the call.' };
  if (name.length < 2) return { ok: false, error: 'That name looks too short. Please enter your full name.' };
  if (!/[A-Za-z\u00C0-\u024F\u0400-\u04FF]/.test(name)) return { ok: false, error: 'Please enter your name using letters.' };
  if (!email) return { ok: false, error: 'Enter your email so we know where to send the blueprint.' };
  if (!EMAIL_RE.test(email)) return { ok: false, error: 'Enter a valid email address.' };
  if (email.length > EMAIL_MAX) return { ok: false, error: 'Email too long.' };
  return { ok: true, name, email };
}

/* ------------------------------------------------------------------ */
/* Spoken figures -> digits                                            */
/* A discovery call is spoken, so numbers arrive as words: "about one  */
/* and a half million a deal", "twenty two percent", "fifty five leads */
/* a month". Function A parses digits, so answer text is normalised    */
/* before the numeric reads. Only number phrases that carry a scale    */
/* word (hundred, thousand, million, k) or sit directly in front of a  */
/* counting unit are rewritten, so ordinary prose stays exactly as the */
/* client said it ("two calls" is never turned into "2 calls").        */
/* ------------------------------------------------------------------ */
const NUM_WORDS = {
  one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10,
  eleven: 11, twelve: 12, thirteen: 13, fourteen: 14, fifteen: 15, sixteen: 16, seventeen: 17,
  eighteen: 18, nineteen: 19, twenty: 20, thirty: 30, forty: 40, fifty: 50, sixty: 60,
  seventy: 70, eighty: 80, ninety: 90
};
const NUM_SCALES = { hundred: 100, thousand: 1000, million: 1000000, billion: 1000000000, k: 1000 };
const NUM_FRACTIONS = { half: 0.5, quarter: 0.25, third: 1 / 3 };
/* Words before a number that make a bare spoken figure worth rewriting ("we close twelve"). */
const COUNT_TRIGGERS = new Set([
  'close', 'closes', 'closed', 'closing', 'win', 'wins', 'won', 'sign', 'signs', 'signed',
  'convert', 'converts', 'converted', 'book', 'books', 'booked', 'get', 'gets', 'getting',
  'spend', 'spends', 'spending', 'cost', 'costs', 'pay', 'pays', 'paid', 'take', 'takes',
  'about', 'around', 'roughly', 'approximately', 'nearly', 'almost', 'maybe', 'only', 'just', 'say'
]);
/* Units that make a bare spoken number worth rewriting. "call" is deliberately absent:
   "two calls" carries the close type and must survive as words. */
const COUNT_UNITS = new Set([
  '%', 'percent', 'pesos', 'peso', 'dollars', 'dollar', 'usd', 'php',
  'leads', 'lead', 'enquiries', 'enquiry', 'inquiries', 'inquiry', 'prospects', 'deals', 'deal',
  'reps', 'rep', 'people', 'person', 'staff', 'headcount', 'employees', 'technicians', 'crews', 'crew',
  'installs', 'install', 'orders', 'order', 'patients', 'clients', 'customers', 'units', 'bookings',
  'month', 'months', 'week', 'weeks', 'day', 'days', 'a', 'per', 'each', 'every', 'times'
]);

function fmtNumberValue(v) {
  if (!Number.isFinite(v)) return null;
  const rounded = Math.round(v * 100) / 100;
  if (Math.abs(rounded - Math.round(rounded)) < 1e-9) return String(Math.round(rounded));
  return String(rounded);
}

function normalizeSpokenNumbers(text) {
  const src = String(text == null ? '' : text);
  if (!src || !/[a-z]/i.test(src)) return src;
  const toks = src.split(/(\s+)/);
  // Tokens carry their punctuation ("percent.", "twelve,"), so every word test runs on a cleaned copy.
  const clean = k => (k >= 0 && k < toks.length ? toks[k].toLowerCase().replace(/^[^\w%$\u20b4\u20ac]+|[^\w%$\u20b4\u20ac]+$/g, '') : '');
  const isWordNum = k => Object.prototype.hasOwnProperty.call(NUM_WORDS, clean(k));
  const isDigitNum = k => /^\d[\d,]*(?:\.\d+)?$/.test(clean(k));
  const isNum = k => isWordNum(k) || isDigitNum(k);
  const isScale = k => Object.prototype.hasOwnProperty.call(NUM_SCALES, clean(k));
  const isFrac = k => Object.prototype.hasOwnProperty.call(NUM_FRACTIONS, clean(k));
  const realIdx = k => { let n = k; while (n < toks.length && toks[n].trim() === '') n++; return n; };
  /* "and a half", "and a quarter", "plus half": the fraction may be one or two tokens ahead. */
  const fracAhead = n => {
    const a = realIdx(n + 1), b = realIdx(a + 1);
    if (isFrac(a)) return a;
    if ((clean(a) === 'a' || clean(a) === 'an' || clean(a) === 'one') && isFrac(b)) return b;
    return -1;
  };

  let out = '';
  let i = 0;
  while (i < toks.length) {
    if (!isNum(i)) { out += toks[i]; i++; continue; }

    // Gather one number phrase: "one and a half million", "twenty two", "1.5 million", "two hundred".
    let j = i;
    let total = 0, cur = 0, frac = '';
    let sawWord = false, sawScale = false, inFrac = false, started = false;
    const closeFrac = () => { if (inFrac && frac) { cur += parseFloat('0.' + frac); frac = ''; } inFrac = false; };
    while (j < toks.length) {
      const n = realIdx(j);
      if (n >= toks.length) break;
      const w = clean(n);
      if (!started) {
        if (isDigitNum(n)) { cur = parseFloat(w.replace(/,/g, '')); started = true; j = n + 1; continue; }
        if (isWordNum(n)) { cur = NUM_WORDS[w]; sawWord = true; started = true; j = n + 1; continue; }
        break;
      }
      if (w === 'point' || w === 'dot') { closeFrac(); inFrac = true; j = n + 1; continue; }
      if (inFrac && (isWordNum(n) || isDigitNum(n))) {
        frac += isWordNum(n) ? String(NUM_WORDS[w]) : w.replace(/,/g, '');
        j = n + 1; continue;
      }
      if (isScale(n)) { closeFrac(); const sc = NUM_SCALES[w]; if (sc === 100) cur = (cur || 1) * 100; else { total += (cur || 1) * sc; cur = 0; } sawScale = true; j = n + 1; continue; }
      if (isWordNum(n)) { cur += NUM_WORDS[w]; sawWord = true; j = n + 1; continue; }
      if (isDigitNum(n)) { cur = cur ? cur + parseFloat(w.replace(/,/g, '')) : parseFloat(w.replace(/,/g, '')); j = n + 1; continue; }
      if ((w === 'and' || w === 'with') && (isWordNum(realIdx(n + 1)) || isDigitNum(realIdx(n + 1)))) { j = n + 1; continue; }
      if (['and', 'a', 'an', 'plus', 'with'].indexOf(w) >= 0 && fracAhead(n) >= 0) {
        const f = fracAhead(n);
        cur += NUM_FRACTIONS[clean(f)];
        sawWord = true; j = f + 1; continue;
      }
      break;
    }
    closeFrac();
    const value = total + cur;
    const end = j;                                   // first index past the phrase
    const unitIdx = realIdx(end);
    const unit = clean(unitIdx);
    const unit2 = clean(realIdx(unitIdx + 1));
    const unitCounts = COUNT_UNITS.has(unit) || ((unit === 'a' || unit === 'per' || unit === 'each' || unit === 'every') && COUNT_UNITS.has(unit2));
    const prevIdx = (() => { let n = i - 1; while (n >= 0 && toks[n].trim() === '') n--; return n; })();
    const triggered = prevIdx >= 0 && COUNT_TRIGGERS.has(clean(prevIdx));
    // Rewrite a scale phrase always ("one and a half million"), and a bare spoken number when it is
    // counting something ("twenty two percent", "fifty five leads") or follows a counting verb.
    const rewrite = started && Number.isFinite(value) && value > 0 && (sawScale || (sawWord && (unitCounts || triggered)));
    const formatted = rewrite ? fmtNumberValue(value) : null;
    if (formatted && toks.slice(i, end).join('').trim() !== formatted) {
      // Keep the punctuation that ended the phrase, so the sentence still reads as the client said it.
      const tail = (toks[end - 1] || '').match(/[^\w%$\u20b4\u20ac]+$/);
      out += formatted + (tail ? tail[0] : '');
      i = end;
      continue;
    }
    out += toks[i];
    i++;
  }
  return out;
}

/* ------------------------------------------------------------------ */
/* Function A logic (mock Claude + Prompt B): answers -> fields        */
/* ------------------------------------------------------------------ */
function extract(answersArr) {
  const a = {};
  (answersArr || []).forEach(x => { a[x.id] = String(x.text || '').trim(); });
  /* p.* is the same text with spoken figures written as digits: every numeric read below uses it,
     while anything shown back to the client (descriptions, notes, goals) keeps their own words. */
  const p = {};
  Object.keys(a).forEach(k => { p[k] = normalizeSpokenNumbers(a[k]); });
  const allText = Object.values(a).join('\n');
  const fields = {
    industry: null, business_description: null, products: [], typical_deal_size: null,
    sales_reps_on_calls: null, fulfilment_headcount: null, marketing_ops_owner: null,
    close_type: null, sales_process_notes: null, lead_sources: [], lead_capture_method: null,
    current_crm: null, current_hubspot_tier: null, current_tools: [], monthly_lead_volume: null,
    monthly_deal_volume: null, close_rate: null, sales_cycle_length: null, biggest_headache: null,
    six_month_goal: null, monthly_marketing_spend: null, monthly_software_budget: null, fulfilment_method: null
  };

  if (a.business) {
    fields.business_description = a.business;
    fields.industry = detectVertical(a.business);
  }
  if (a.products) {
    const items = p.products.split(/\n|;/)
      // Spoken answers arrive as one sentence: "residential at 1.2m, and commercial at 4.5m".
      .reduce((acc, seg) => acc.concat(seg.split(/,?\s+(?:and|plus|then)\s+(?=[^,;]*?\b(?:at|for|costs?|priced|goes for)\s+[\d\u20b4$\u20ac])/i)), [])
      .map(s => s.trim()).filter(s => s.length > 2);
    for (const rawIt of items) {
      // Spoken items arrive with the sentence punctuation still on the end ("... a site survey first.").
      const it = String(rawIt).trim().replace(/[.,;:\s]+$/, '');
      const atPrice = it.match(/\b(?:at|for|costs?|priced(?:\s+at)?|goes for|around|about)\s+([\d][\d,]*(?:\.\d+)?)\b/i);
      const price = firstMoney(it) != null ? firstMoney(it) : (atPrice ? Math.round(parseFloat(atPrice[1].replace(/,/g, ''))) : null);
      const preM = it.match(/(?:needs?|requires?|after|following|must|have to|we do)\s+(?:an?\s+)?([a-z0-9 -]{3,40}?)(?:\s+first)?$/i);
      const name = it
        .replace(/,?\s*(?:and|plus)\b.*$/i, '')
        .replace(/,\s*(?:after|needs?|requires?|following)\b.*$/i, '')
        .replace(/\s*(?:at|for|priced at|costs)\s+[₴$€]?\s*[\d,.]+\s*(?:(?:pesos?|pounds?|dollars?)\s*)?(?:a\s+month|per\s+month)?\s*$/i, '')
        .replace(/\s*[,;:]\s*$/, '')
        .trim();
      if (name) fields.products.push({ name, price: price != null ? price : null, prerequisite: preM ? preM[1].trim() : null });
    }
  }
  if (a.deal) {
    const dm = p.deal.match(/([\d][\d,]*(?:\.\d+)?)\s*(?:a|per|each|one)\s+(?:typical\s+|average\s+)?(deal|job|order|sale)\b/i);
    fields.typical_deal_size = dm ? Math.round(parseFloat(dm[1].replace(/,/g, ''))) : firstMoney(p.deal);
    const rm = p.deal.match(new RegExp('\\b(' + WORD_RE + ')\\s*(?:sales\\s*)?reps?\\b', 'i'));
    const pm = p.deal.match(new RegExp('\\b(' + WORD_RE + ')\\s*(?:people|person|staff|of us)\\s*(?:who\\s*)?take\\s*(?:those\\s*|the\\s*)?calls', 'i'));
    const hm = p.deal.match(new RegExp('\\b(' + WORD_RE + ')\\s+person\\s+handles', 'i'));
    fields.sales_reps_on_calls = rm ? wordOrNum(rm[1]) : (pm ? wordOrNum(pm[1]) : (hm ? wordOrNum(hm[1]) : null));
  }
  if (a.fulfilment) {
    const hc = p.fulfilment.match(new RegExp('\\b(' + WORD_RE + ')\\s+(?:people|person|staff|technicians|contractors|assistants|crew|members|dentists|doctors|reps|installers|team)\\b', 'i'));
    if (hc) fields.fulfilment_headcount = wordOrNum(hc[1]);
    const t = p.fulfilment.toLowerCase();
    if (/our own (crew|team)|in-house|we deliver|we pack|we do it ourselves|we fulfil/.test(t)) fields.fulfilment_method = 'In-house team';
    else if (/contractors|subcontractors|outsource|third-party/.test(t)) fields.fulfilment_method = 'Contractors';
  }
  if (a.owner) {
    const t = a.owner;
    if (/^me\b|it is me|it'?s me|i handle/i.test(t)) fields.marketing_ops_owner = 'The owner (you)';
    else {
      const nm = t.match(/(?:my|our)\s+(?:operations\s+)?(manager|assistant|head|lead|director|brother|sister)\s*,?\s*([A-Z][A-Za-z]+)?/i);
      if (nm && nm[2]) {
        const role = nm[1];
        const roleLabel = /operations/i.test(t) && role === 'manager' ? 'Operations manager' : role.charAt(0).toUpperCase() + role.slice(1) + (role === 'brother' || role === 'sister' ? '' : ' (ops)');
        fields.marketing_ops_owner = nm[2] + ' (' + roleLabel + ')';
      } else fields.marketing_ops_owner = t.length > 60 ? t.slice(0, 57) + '...' : t;
    }
  }
  if (a.close) {
    const c = a.close.toLowerCase();
    if (/two calls|second call|follow.?up call|one to quote, one to|then we present|first we qualify/.test(c)) fields.close_type = 'two-call';
    else if (/one call|single call|same call|book the first visit straight|self-checkout|most orders are self/.test(c)) fields.close_type = 'one-call';
    fields.sales_process_notes = a.close.length > 300 ? a.close.slice(0, 297) + '...' : a.close;
  }
  if (a.sources) {
    const lines = p.sources.split(/\n|;|\.\s+|,\s*(?=[A-Z])/).map(s => s.trim()).filter(s => s && /[a-z]/i.test(s));
    for (const line of lines) {
      const numM = line.match(/\b(\d+(?:\.\d+)?)\b/);
      if (!numM) continue;
      let name = line.slice(0, numM.index)
        .replace(/\s*(?:about|around|roughly|approximately)\s*$/i, '')
        .replace(/\b(?:tracked|untracked)\b/gi, '')
        .replace(/[^a-z0-9&/'-]*$/i, '')
        .replace(/^(?:and|plus|,|\s)+/i, '')
        .trim();
      if (name.length < 2) name = 'Other';
      let tracked = null;
      if (/not (being )?tracked|untracked|no idea|don'?t track|we don'?t (know|track)/i.test(line)) tracked = false;
      else if (/tracked|we count|we track/i.test(line)) tracked = true;
      const existing = fields.lead_sources.find(s => s.source.toLowerCase() === name.toLowerCase());
      if (existing) { existing.monthly_volume = Math.round(parseFloat(numM[1])); existing.tracked = tracked != null ? tracked : existing.tracked; }
      else fields.lead_sources.push({ source: name, monthly_volume: Math.round(parseFloat(numM[1])), tracked });
    }
  }
  if (a.capture) {
    const t = a.capture.toLowerCase();
    const crmTool = detectTools(t).find(n => ['HubSpot', 'Salesforce', 'Zoho CRM', 'Pipedrive', 'Freshsales', 'GoHighLevel'].includes(n));
    fields.current_crm = crmTool || (/(no (real )?crm|not using|nothing|paper only|excel|spreadsheet|manual)/.test(t) ? 'None (manual)' : null);
    const tierM = a.capture.match(/\b(starter|professional|enterprise)\b/i);
    if (tierM) fields.current_hubspot_tier = tierM[1].charAt(0).toUpperCase() + tierM[1].slice(1);
    if (/spreadsheet/i.test(t)) fields.lead_capture_method = 'Spreadsheets (manual entry)';
    else if (/whatsapp/.test(t) && /message|chat|take messages/.test(t)) fields.lead_capture_method = 'WhatsApp (manual)';
    else if (/inbox|gmail/i.test(t)) fields.lead_capture_method = 'Email inbox';
    else if (crmTool) fields.lead_capture_method = crmTool + ' (CRM)';
  }
  fields.current_tools = detectTools(allText);
  if (a.volumes) {
    const t = p.volumes;
    const lv = t.match(/\b(\d+)\s*(leads|enquiries|inquiries|contacts|prospects)\b/i) || t.match(/^\s*(\d+)\s*(?:a|per|each)\s+month/i);
    if (lv) fields.monthly_lead_volume = parseInt(lv[1], 10);
    const dv = t.match(/\b(close|convert|finish|complete|book|sign|win)\w*\s+(about |around |roughly |maybe )?(\d+)/i);
    if (dv) fields.monthly_deal_volume = parseInt(dv[3], 10);
    else if (fields.monthly_lead_volume != null) {
      const dm2 = t.match(/\b(\d+)\s*(deals|sales|installs|orders|bookings|jobs)\b/i);
      if (dm2) fields.monthly_deal_volume = parseInt(dm2[1], 10);
    }
    const rv = t.match(/\b(\d+(?:\.\d+)?)\s*(percent|%)|(\d+)\s*out of\s+(\d+)/i);
    if (rv) fields.close_rate = rv[1] != null ? parseFloat(rv[1]) : Math.round((100 * parseInt(rv[3], 10)) / parseInt(rv[4], 10));
    const cv = t.match(new RegExp('\\b(' + WORD_RE + ')\\s*(day|week|month)s?\\b', 'i'));
    if (cv) {
      const n = wordOrNum(cv[1]);
      if (n != null) fields.sales_cycle_length = cv[2] === 'day' ? Math.max(0.1, n / 7) : cv[2] === 'month' ? Math.round(n * 4.33 * 10) / 10 : n;
    } else if (/same week|a\s+week/i.test(t)) fields.sales_cycle_length = 1;
    else if (/same day|a\s+day/i.test(t)) fields.sales_cycle_length = 0.1;
    if (fields.monthly_lead_volume == null) {
      const sum = fields.lead_sources.reduce((t2, s) => t2 + (num(s.monthly_volume) || 0), 0);
      if (sum > 0) fields.monthly_lead_volume = sum;
    }
  }
  if (a.spend) {
    const mk = p.spend.match(/([\d][\d,]*(?:\.\d+)?)\s*(?:pesos?\s*)?(?:a|per|each)?\s*month\s*(?:on|for)?\s+(ads|marketing|google|facebook|social|lead gen)/i) ||
      p.spend.match(/([\d][\d,]*(?:\.\d+)?)\s+on\s+(ads|marketing|google|facebook|social|lead gen)/i);
    if (mk) fields.monthly_marketing_spend = Math.round(parseFloat(mk[1].replace(/,/g, '')));
    const sw = p.spend.match(/([\d][\d,]*(?:\.\d+)?)\s*(?:pesos?\s*)?(?:a|per|each)?\s*month\s*(?:on|for)?\s+(software|tools|subscriptions|saas)/i) ||
      p.spend.match(/([\d][\d,]*(?:\.\d+)?)\s+on\s+(software|tools|subscriptions|saas)/i);
    if (sw) fields.monthly_software_budget = Math.round(parseFloat(sw[1].replace(/,/g, '')));
    if (fields.monthly_marketing_spend == null) { const ms = moneyMatches(p.spend); if (ms.length >= 1) fields.monthly_marketing_spend = ms[0].value; }
    if (fields.monthly_software_budget == null) { const ms = moneyMatches(p.spend); if (ms.length >= 2) fields.monthly_software_budget = ms[1].value; }
  }
  if (a.headache) fields.biggest_headache = a.headache;
  if (a.goal) fields.six_month_goal = a.goal;
  return fields;
}

/* ------------------------------------------------------------------ */
/* Function B logic (mock Claude + Prompt A + KB): fields -> blueprint */
/* ------------------------------------------------------------------ */
function generate(fields) {
  const ref = new Set();
  const vKey = KB.verticals[fields.industry] ? fields.industry : 'generic';
  const recipe = KB.verticals[vKey];
  const L = num(fields.monthly_lead_volume);
  const C = num(fields.monthly_deal_volume);
  const D = num(fields.typical_deal_size);
  const R = fields.close_rate != null ? num(fields.close_rate) / 100 : null;
  const reps = num(fields.sales_reps_on_calls) || 0;
  const cyc = num(fields.sales_cycle_length) || 0;
  const spend = num(fields.monthly_marketing_spend) || 0;

  let enterprise = false;
  const rationale = [KB.tiers.floor.rule];
  ref.add(KB.tiers.floor.id);
  if (reps >= KB.tiers.enterprise.minReps || cyc >= KB.tiers.enterprise.minCycleWeeks || (L || 0) >= KB.tiers.enterprise.minLeads) {
    enterprise = true;
    ref.add(KB.tiers.enterprise.id);
    rationale.push(KB.tiers.enterprise.rule);
  }
  const addOns = [];
  if (spend >= KB.tiers.marketing.minSpend || (L || 0) >= KB.tiers.marketing.minLeads) { addOns.push('Marketing Hub Professional'); ref.add(KB.tiers.marketing.id); }
  if (recipe.serviceHub) { addOns.push('Service Hub Professional'); ref.add(KB.tiers.service.id); rationale.push(recipe.serviceHubReason); }
  const hubs = 1 + addOns.length;
  const seats = Math.max(2, reps, 3);
  const perMonth = hubs * seats * KB.tiers.pricing.perSeatUSD;
  ref.add('KB-PRISE-01');
  const tierName = enterprise ? 'Sales Hub Professional, with Enterprise review' : 'Sales Hub Professional';

  const variant = fields.close_type === 'one-call' ? 'one-call' : 'two-call';
  const pipe = KB.pipelines[variant];
  ref.add(pipe.id);

  const srcs = (fields.lead_sources || []).map(s => {
    const key = (s.source || '').toLowerCase();
    const mech = KB.sourceMechanisms.find(m => m.match.some(k => key.includes(k)));
    const used = mech || KB.sourceMechanismDefault;
    ref.add(used.id);
    return { name: s.source, monthlyVolume: num(s.monthly_volume), tracked: s.tracked, mechanism: used.text };
  });

  const tools = (fields.current_tools || []).map(name => {
    const e = KB.tools[name] || { action: 'Keep', reason: 'Reviewed at the build call. No change recommended in v1.' };
    let reason = e.reason;
    if (name === 'HubSpot' && fields.current_hubspot_tier) reason = 'You are on ' + fields.current_hubspot_tier + '. ' + e.reason;
    ref.add('KB-TOOL-' + String(name).replace(/[^A-Za-z]/g, '').slice(0, 14));
    return { name, action: e.action, reason };
  });

  const custom = [];
  custom.push('Pipeline: ' + recipe.label.toLowerCase() + ' pipeline with ' + pipe.stages.length + ' stages, matched to your ' + variant + ' close pattern');
  custom.push('Custom properties from your answers: product, list price, deal size, fulfilment status, and lead source volume');
  srcs.forEach(s => custom.push('Form and tracking for: ' + s.name + (s.tracked === false ? ' (currently untracked, this brings it into view)' : '')));
  recipe.workflows.forEach(w => custom.push('Workflow: ' + w));
  custom.push('Dashboard: monthly leads, closed deals, close rate, and pipeline value by source');
  ref.add('KB-BUILD-01');

  const coa = [];
  const lost = Math.max(0, (L || 0) - (C || 0));
  coa.push({
    title: 'Deals lost to slow follow-up', value: lost * (D || 0) * 0.2, period: 'per month',
    basis: L + ' leads in, ' + C + ' closed, ' + lost + ' slipping each month. Assumption: 20% of slipped deals are winnable with faster follow-up. Valued at ' + fmtMoney(D) + ' typical deal.'
  });
  const untracked = (fields.lead_sources || []).filter(s => s.tracked === false).reduce((t, s) => t + (num(s.monthly_volume) || 0), 0);
  if (untracked > 0) {
    coa.push({
      title: 'Value hiding in untracked sources', value: untracked * (R || 0.2) * (D || 0), period: 'per month',
      basis: untracked + ' leads a month are untracked today. Assumption: they close at your ' + Math.round((R || 0.2) * 100) + '% rate. Valued at ' + fmtMoney(D) + ' typical deal.'
    });
  } else {
    coa.push({
      title: 'Value leaking from unmanaged hand-offs', value: (C || 0) * (D || 0) * 0.05, period: 'per month',
      basis: 'You close ' + C + ' deals a month. Assumption: 5% leak between sales and fulfilment without a system of record. Valued at ' + fmtMoney(D) + ' typical deal.'
    });
  }
  const goalTxt = fields.six_month_goal || '';
  const gm = goalTxt.match(/\b(\d+)\s*(?:closed\s+|completed\s+|finished\s+)?(deals|sales|installs|jobs|bookings|orders|patients|customers|clients)/i);
  const gp = goalTxt.match(/\b(\d+)\s*percent\s+more/i);
  if (gm) {
    const target = parseInt(gm[1], 10);
    coa.push({
      title: 'Gap to your six-month goal of ' + target + ' ' + gm[2] + ' a month',
      value: Math.max(0, target - (C || 0)) * (D || 0) * 6, period: 'over 6 months',
      basis: 'Target ' + target + ' ' + gm[2] + ' a month versus ' + C + ' today. That is ' + Math.max(0, target - (C || 0)) + ' extra ' + gm[2] + ' at ' + fmtMoney(D) + ' each, over six months.'
    });
  } else if (gp) {
    const pct = parseInt(gp[1], 10);
    coa.push({
      title: 'Closing a ' + pct + '% growth gap', value: (C || 0) * (pct / 100) * (D || 0) * 6, period: 'over 6 months',
      basis: 'Your goal states ' + pct + '% more. That is ' + Math.round((C || 0) * pct / 100) + ' extra deals a month at ' + fmtMoney(D) + ', over six months.'
    });
  } else {
    coa.push({
      title: 'Cost of staying at the current run-rate', value: (C || 0) * 0.33 * (D || 0) * 6, period: 'over 6 months',
      basis: 'No number was stated, so this assumes a one-third uplift on ' + C + ' deals a month at ' + fmtMoney(D) + ', over six months. Confirm the number at the call.'
    });
  }
  const totalMonthly = coa.filter(c => c.period === 'per month').reduce((t, c) => t + c.value, 0);
  const totalSix = totalMonthly * 6 + coa[2].value;

  const compliance = recipe.compliance.map(c => { ref.add(c.id); return { code: c.code, note: c.note }; });

  const dateStr = new Date().toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'Asia/Manila' });
  const crmName = fields.current_crm && !String(fields.current_crm).startsWith('None') ? fields.current_crm : null;
  const toolsArr = (fields.current_tools || []).filter(t => t !== crmName);
  const toolsStr = toolsArr.length ? toolsArr.join(', ') : 'manual tools';
  const crmDisplay = fields.current_crm === 'None (manual)' ? 'no CRM (manual tracking)' : (fields.current_crm || 'no CRM');
  const summaryText = (fields.business_description || 'Your business') + ' You currently bring in about ' + (L || 0) +
    ' leads a month and close ' + (C || 0) + ' (' + Math.round((R || 0) * 100) + '%), running on ' +
    crmDisplay + ' with ' + toolsStr + '. This blueprint moves you to ' + tierName +
    (addOns.length ? ' plus ' + addOns.join(' and ') : '') + ', installs a ' + pipe.label.toLowerCase() +
    ' across ' + srcs.length + ' lead sources, and works towards: ' + (fields.six_month_goal || 'your six-month goal') +
    '. Estimated cost of inaction: ' + fmtMoney(totalMonthly) + ' per month.';

  return {
    meta: {
      businessLine: (fields.business_description || 'Your business').slice(0, 90),
      vertical: vKey, verticalLabel: recipe.label, date: dateStr,
      generatedBy: 'PipelineSync AI (Claude, Prompt A) + knowledge base v1'
    },
    summary: {
      text: summaryText,
      stats: [
        { label: 'Leads / month', value: L != null ? String(L) : 'n/a' },
        { label: 'Closed / month', value: C != null ? String(C) : 'n/a' },
        { label: 'Close rate', value: fields.close_rate != null ? fields.close_rate + '%' : 'n/a' },
        { label: 'Typical deal', value: D != null ? fmtMoney(D) : 'n/a' }
      ]
    },
    stack: {
      tier: tierName, enterprise, addOns,
      pricingLine: hubs + ' hub(s) x ' + seats + ' seats x USD ' + KB.tiers.pricing.perSeatUSD + ' per seat per month = approx. USD ' + perMonth.toLocaleString('en-US') + ' per month',
      pricingNote: KB.tiers.pricing.note, rationale
    },
    pipeline: { variant, label: pipe.label, stages: pipe.stages, note: pipe.note, workflows: recipe.workflows },
    leadSources: srcs,
    tools,
    build: { defaults: KB.defaults.slice(), custom },
    coa: { items: coa, totalMonthly, totalSix },
    compliance,
    nextSteps: [
      'Book the 30-minute call to walk through this blueprint (scheduler below).',
      'Confirm scope: hubs, seats, and the custom items list in section 6.',
      'Launch in 2 to 3 weeks, then a 30-day tuning review of workflow performance.'
    ],
    kbReferences: Array.from(ref).sort()
  };
}

/* ------------------------------------------------------------------ */
/* Function C logic (real, server-side): blueprint -> PDF, pure JS     */
/* ------------------------------------------------------------------ */
const HW = { ' ': 278, '!': 278, '"': 355, '#': 556, '$': 556, '%': 889, '&': 667, "'": 191, '(': 333, ')': 333, '*': 389, '+': 584, ',': 278, '-': 333, '.': 278, '/': 278, '0': 556, '1': 556, '2': 556, '3': 556, '4': 556, '5': 556, '6': 556, '7': 556, '8': 556, '9': 556, ':': 278, ';': 278, '<': 584, '=': 584, '>': 584, '?': 556, '@': 1015,
  A: 667, B: 667, C: 722, D: 722, E: 667, F: 611, G: 778, H: 722, I: 278, J: 500, K: 667, L: 556, M: 833, N: 722, O: 778, P: 667, Q: 778, R: 722, S: 667, T: 611, U: 722, V: 667, W: 944, X: 667, Y: 667, Z: 611,
  a: 556, b: 556, c: 500, d: 556, e: 556, f: 278, g: 556, h: 556, i: 222, j: 222, k: 500, l: 222, m: 833, n: 556, o: 556, p: 556, q: 556, r: 333, s: 500, t: 278, u: 556, v: 500, w: 722, x: 500, y: 500, z: 500 };
function textWidth(s, size) {
  let w = 0;
  for (const ch of String(s)) w += HW[ch] != null ? HW[ch] : 556;
  return (w / 1000) * size;
}
function wrapText(text, size, maxW) {
  const words = String(text).split(' ');
  const lines = [];
  let cur = '';
  for (const wd of words) {
    const t = cur ? cur + ' ' + wd : wd;
    if (textWidth(t, size, maxW) <= maxW || !cur) cur = t;
    else { lines.push(cur); cur = wd; }
  }
  if (cur) lines.push(cur);
  return lines.length ? lines : [''];
}
function ascii(s) {
  return String(s)
    .replace(/₴/g, 'PHP ')
    .replace(/£/g, 'GBP ')
    .replace(/[\u2018\u2019]/g, "'")
    .replace(/[\u201C\u201D]/g, '"')
    .replace(/[\u2013\u2014]/g, '-')
    .replace(/[^\x20-\x7E]/g, '');
}
function pdfEsc(s) {
  return ascii(s).replace(/\\/g, '\\\\').replace(/\(/g, '\\(').replace(/\)/g, '\\)');
}
function blueprintToBlocks(bp) {
  const B = [];
  B.push({ t: 'title', txt: 'REVENUE OPERATIONS BLUEPRINT' });
  B.push({ t: 'sub', txt: ascii(bp.meta.businessLine) + '  |  ' + bp.meta.verticalLabel + '  |  Prepared ' + bp.meta.date });
  B.push({ t: 'gap', n: 14 });
  B.push({ t: 'h', txt: '1. Executive summary' });
  B.push({ t: 'p', txt: bp.summary.text });
  (bp.summary.stats || []).forEach(st => B.push({ t: 'b', txt: st.label + ': ' + st.value }));
  B.push({ t: 'gap', n: 8 });
  B.push({ t: 'h', txt: '2. Recommended HubSpot stack' });
  B.push({ t: 'b', txt: 'Core: ' + bp.stack.tier });
  B.push({ t: 'b', txt: 'Enterprise review: ' + (bp.stack.enterprise ? 'yes' : 'no') });
  bp.stack.addOns.forEach(a => B.push({ t: 'b', txt: 'Add-on: ' + a }));
  B.push({ t: 'b', txt: bp.stack.pricingLine });
  B.push({ t: 'note', txt: bp.stack.pricingNote });
  bp.stack.rationale.forEach(r => B.push({ t: 'b', txt: r }));
  B.push({ t: 'gap', n: 8 });
  B.push({ t: 'h', txt: '3. Pipeline architecture' });
  B.push({ t: 'p', txt: bp.pipeline.label + ' (' + bp.pipeline.variant + ' close). ' + bp.pipeline.note });
  B.push({ t: 'b', txt: 'Stages: ' + bp.pipeline.stages.join('  >  ') });
  bp.pipeline.workflows.forEach(w => B.push({ t: 'b', txt: 'Workflow: ' + w }));
  B.push({ t: 'gap', n: 8 });
  B.push({ t: 'h', txt: '4. Lead source architecture' });
  if (!bp.leadSources.length) B.push({ t: 'p', txt: 'No lead sources were stated. Add them at the build call and each one gets a form plus volume tracking.' });
  bp.leadSources.forEach(s => B.push({ t: 'b', txt: (s.name || 'Source') + ' (' + (s.monthlyVolume != null ? s.monthlyVolume : '?') + '/mo, ' + (s.tracked === false ? 'not tracked' : s.tracked === true ? 'tracked' : 'tracking unclear') + '): ' + s.mechanism }));
  B.push({ t: 'gap', n: 8 });
  B.push({ t: 'h', txt: '5. Tool mapping (current -> recommended)' });
  if (!bp.tools.length) B.push({ t: 'p', txt: 'No tools were stated. Review the stack at the build call.' });
  bp.tools.forEach(t => B.push({ t: 'b', txt: t.name + '  ->  ' + t.action + '. ' + t.reason }));
  B.push({ t: 'gap', n: 8 });
  B.push({ t: 'h', txt: '6. Build plan' });
  B.push({ t: 'p', txt: 'Confirmed defaults (included in the tier):' });
  bp.build.defaults.forEach(d => B.push({ t: 'b', txt: d }));
  B.push({ t: 'p', txt: 'Custom items to create for you:' });
  bp.build.custom.forEach(d => B.push({ t: 'b', txt: d }));
  B.push({ t: 'gap', n: 8 });
  B.push({ t: 'h', txt: '7. Cost of inaction (from your numbers)' });
  bp.coa.items.forEach(c => {
    B.push({ t: 'nb', lead: c.title + '  ' + fmtMoney(c.value) + '  (' + c.period + ')' });
    B.push({ t: 'note', txt: 'Basis: ' + c.basis });
  });
  B.push({ t: 'gap', n: 4 });
  B.push({ t: 'p', txt: 'Total estimated cost of inaction: ' + fmtMoney(bp.coa.totalMonthly) + ' per month, ' + fmtMoney(bp.coa.totalSix) + ' over six months.' });
  B.push({ t: 'gap', n: 8 });
  B.push({ t: 'h', txt: '8. Compliance' });
  if (bp.compliance.length) bp.compliance.forEach(c => B.push({ t: 'b', txt: c.code + ': ' + c.note }));
  else B.push({ t: 'p', txt: 'No compliance flags in knowledge base v1 for this vertical.' });
  B.push({ t: 'gap', n: 8 });
  B.push({ t: 'h', txt: '9. Next steps' });
  bp.nextSteps.forEach((s, i) => B.push({ t: 'b', txt: (i + 1) + '. ' + s }));
  B.push({ t: 'gap', n: 8 });
  B.push({ t: 'h', txt: '10. Knowledge base references' });
  B.push({ t: 'p', txt: 'Sourced exclusively from knowledge base v1 (no invented items): ' + bp.kbReferences.join(', ') });
  B.push({ t: 'note', txt: bp.meta.generatedBy });
  B.push({ t: 'gap', n: 14 });
  B.push({ t: 'note', txt: 'Generated by PipelineSync AI from your confirmed answers and knowledge base v1 (rules, tools, prices). Figures are planning estimates, not a quote. Prepared in UK English.' });
  return B;
}
function buildPdf(bp) {
  const W = 595, H = 842, M = 56;
  const MAXW = W - M * 2;
  const dateStr = bp.meta.date || '';
  const blocks = blueprintToBlocks(bp);
  const pages = [];
  let page = [];
  let y = H - 108;
  const push = (f, s, txt, x) => {
    const lh = s * 1.5;
    if (y - lh < 78) { pages.push(page); page = []; y = H - 108; }
    page.push({ f, s, x: x == null ? M : x, y: y - lh, txt });
    y -= lh;
  };
  const wrapPush = (f, s, txt, bullet) => {
    const lines = wrapText(txt, s, MAXW - (bullet ? 16 : 0));
    lines.forEach((ln, i) => push(f, s, (bullet && i === 0 ? '-  ' : '') + ln, bullet ? M + 16 : M));
  };
  for (const b of blocks) {
    const txt = ascii(b.txt);
    if (b.t === 'gap') { y -= b.n || 10; continue; }
    if (b.t === 'title') { push('F2', 20, txt); y -= 6; }
    else if (b.t === 'sub') push('F1', 9.5, txt);
    else if (b.t === 'h') { push('F2', 12.5, txt); y -= 3; }
    else if (b.t === 'p') wrapPush('F1', 9.8, txt);
    else if (b.t === 'b') wrapPush('F1', 9.8, txt, true);
    else if (b.t === 'nb') { push('F2', 9.8, ascii(b.lead), M); if (b.body) wrapPush('F1', 9.8, txt, true); }
    else if (b.t === 'note') wrapPush('F1', 8.2, txt);
  }
  if (page.length) pages.push(page);
  const total = pages.length;
  const objStrings = [];
  const kids = pages.map((_, i) => (5 + i * 2) + ' 0 R').join(' ');
  objStrings.push('1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj');
  objStrings.push('2 0 obj\n<< /Type /Pages /Kids [' + kids + '] /Count ' + total + ' >>\nendobj');
  objStrings.push('3 0 obj\n<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>\nendobj');
  objStrings.push('4 0 obj\n<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold /Encoding /WinAnsiEncoding >>\nendobj');
  pages.forEach((pg, i) => {
    const pageNum = 5 + i * 2, contentNum = 6 + i * 2;
    objStrings.push(pageNum + ' 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ' + W + ' ' + H + '] /Resources << /Font << /F1 3 0 R /F2 4 0 R >> >> /Contents ' + contentNum + ' 0 R >>\nendobj');
    let cs = '0 g\nBT\n';
    cs += '/F2 9 Tf 1 0 0 1 ' + M + ' ' + (H - 44) + ' Tm (PIPELINESYNC AI) Tj\n';
    const right = 'REVENUE OPERATIONS BLUEPRINT';
    const rw = textWidth(right, 9);
    cs += '/F1 9 Tf 1 0 0 1 ' + (W - M - rw).toFixed(1) + ' ' + (H - 44) + ' Tm (' + pdfEsc(right) + ') Tj\n';
    cs += '0.97 0.48 0.35 RG 0.8 w ' + M + ' ' + (H - 52) + ' m ' + (W - M) + ' ' + (H - 52) + ' l S\n';
    for (const L of pg) cs += '/' + L.f + ' ' + L.s + ' Tf 1 0 0 1 ' + L.x + ' ' + L.y.toFixed(1) + ' Tm (' + pdfEsc(L.txt) + ') Tj\n';
    cs += 'ET\n';
    cs += '0.45 g\nBT /F1 8 Tf 1 0 0 1 ' + M + ' 40 Tm (Page ' + (i + 1) + ' of ' + total + '  |  PipelineSync AI  |  ' + pdfEsc(dateStr) + '  |  Generated server-side) Tj ET\n';
    cs += '0.45 g 0.4 w ' + M + ' 52 m ' + (W - M) + ' 52 l S\n';
    const len = Buffer.byteLength(cs, 'latin1');
    objStrings.push(contentNum + ' 0 obj\n<< /Length ' + len + ' >>\nstream\n' + cs + 'endstream\nendobj');
  });
  let out = '%PDF-1.4\n';
  const offsets = [];
  for (const s of objStrings) { offsets.push(Buffer.byteLength(out, 'latin1')); out += s + '\n'; }
  const xref = Buffer.byteLength(out, 'latin1');
  const size = objStrings.length + 1;
  out += 'xref\n0 ' + size + '\n0000000000 65535 f \n';
  offsets.forEach(o => { out += String(o).padStart(10, '0') + ' 00000 n \n'; });
  out += 'trailer\n<< /Size ' + size + ' /Root 1 0 R >>\nstartxref\n' + xref + '\n%%EOF';
  return Buffer.from(out, 'latin1');
}

/* ------------------------------------------------------------------ */
/* Function D logic: the lead payload that goes to HubSpot.            */
/* In the prototype it is logged (Netlify function logs / local conso) */
/* ------------------------------------------------------------------ */
function makeLeadPayload(email, name, fields, bp, voiceCall) {
  const lead = {
    portal: 'mock-hubspot', contact_id: newContactId(), email, name,
    source: 'pipelinesync-ai-blueprint', lifecycle_stage: 'lead',
    created_at: new Date().toISOString(),
    industry: bp.meta.vertical,
    answers: fields || null,
    blueprint_ref: { vertical: bp.meta.verticalLabel, tier: bp.stack.tier, pipeline: bp.pipeline.label, kb_version: KB.version, kb_references: bp.kbReferences }
  };
  // How the discovery call was run (voice provider, models, turns, coverage at call end).
  // Absent for typed journeys; never contains audio.
  if (voiceCall && typeof voiceCall === 'object') lead.voice_call = voiceCall;
  return lead;
}
function pdfFilename(bp) {
  return 'PipelineSync_Blueprint_' + bp.meta.verticalLabel.replace(/\s+/g, '') + '_' + new Date().toISOString().slice(0, 10) + '.pdf';
}

const PROMPT_A = PROMPTS ? PROMPTS.PROMPT_A : null;
const PROMPT_B = PROMPTS ? PROMPTS.PROMPT_B : null;

module.exports = {
  KB, num, extract, generate, buildPdf, signToken, verifyToken, loginNameFor, normalizeSpokenNumbers,
  cleanName, firstNameOf, initialsOf, validateEntry,
  makeLeadPayload, pdfFilename, fmtMoney,
  TOKEN_TTL_MS, NAME_MAX, EMAIL_MAX,
  tokenSecretStatus, isProductionEnv, MIN_TOKEN_SECRET,
  PROMPT_A, PROMPT_B,
  PROMPTS
};
