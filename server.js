'use strict';
/*
 * PipelineSync AI - LOCAL dev server (Node, zero dependencies).
 * Run: node server.js   (http://0.0.0.0:8080)
 *
 * The deployed prototype (GitHub -> Netlify) runs the same logic from
 * netlify/functions/*.js against the same shared core (lib/core.js).
 * Local extras: in-memory HubSpot outbox view at /dev/outbox.
 * Hardened: XSS fix, security headers, rate limiting, path traversal hardening.
 */
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const core = require('./lib/core');
const leads = require('./lib/supabase-leads');
const hubspot = require('./lib/hubspot');
const voice = require('./lib/voice');
const { handleVoice, clampVoiceMeta, rateLimitFor } = require('./lib/voice-api');
const anthropic = require('./lib/anthropic');
const aiPipeline = require('./lib/ai-pipeline');
const blueprintSchema = require('./lib/blueprint-schema');
const jobStore = require('./lib/job-store');
const generateJob = require('./lib/generate-job');
const deliverCore = require('./lib/deliver-core');

/* Zero-dependency .env loader: reads KEY=VALUE lines from a .env in the repo root, skipping
   blanks and comment lines, stripping inline " # comments" and surrounding quotes. Real
   environment variables always win, so `OPENAI_API_KEY=sk-... node server.js` still overrides
   the file (and the mock: `OPENAI_BASE_URL=http://127.0.0.1:8099/v1 ...`). The Netlify deploy
   never sees this file - its functions read their own environment. Without a .env the server
   simply runs on the process environment, as before. */
(function loadDotEnv() {
  let file;
  try { file = fs.readFileSync(path.join(__dirname, '.env'), 'utf8'); } catch (e) { return; }
  // Pass 1: parse every line (a repeated key later in the file wins, like dotenv).
  const parsed = {};
  for (const line of file.split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
    if (!m) continue; // blank and comment lines
    let val = m[2].trim();
    const hash = val.search(/\s#/);
    if (hash !== -1) val = val.slice(0, hash).trim();
    if (val.length >= 2 && ((val[0] === '"' && val[val.length - 1] === '"') || (val[0] === "'" && val[val.length - 1] === "'"))) {
      val = val.slice(1, -1);
    }
    parsed[m[1]] = val;
  }
  // Pass 2: apply only the keys the real environment does not already set.
  for (const k of Object.keys(parsed)) if (!(k in process.env)) process.env[k] = parsed[k];
})();

const PORT = process.env.PORT || 8080;
const HOST = '0.0.0.0';
const PUBLIC_DIR = path.resolve(__dirname, 'public');

const hubSpotOutbox = []; // local-only stand-in view of Function D pushes

/* ------------------------------------------------------------------ */
/* Security helpers                                                    */
/* ------------------------------------------------------------------ */
function escHtml(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, c => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  }[c]));
}

function securityHeaders() {
  // The voice layer plays OpenAI speech from a blob: or data: URL, so media-src must allow both
  // (default-src 'self' alone would have the browser refuse to play the AI voice).
  const csp = "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; img-src 'self' data: blob: https://*.hubspot.com; media-src 'self' blob: data:; connect-src 'self' https://*.hubspot.com; font-src 'self' https://fonts.gstatic.com data:; frame-src 'self' https://meetings.hubspot.com https://app.hubspot.com https://*.hubspot.com; object-src 'none'; base-uri 'self'; " +
    // Production (Netlify) sends frame-ancestors 'none'. The local dev server is embedded in the
    // preview pane, so it must stay framable here; PS_ALLOW_FRAMING=0 restores the strict rule.
    (process.env.PS_ALLOW_FRAMING === '0' ? "frame-ancestors 'none'" : "frame-ancestors *");
  return {
    'X-Content-Type-Options': 'nosniff',
    // X-Frame-Options cannot express "allow any ancestor", so it is only sent when framing is denied.
    ...(process.env.PS_ALLOW_FRAMING === '0' ? { 'X-Frame-Options': 'DENY' } : {}),
    'Referrer-Policy': 'strict-origin-when-cross-origin',
    'Permissions-Policy': 'microphone=(self), camera=()',
    'Content-Security-Policy': csp,
  };
}

// Simple in-memory rate limiter for the entry gate and the voice routes (per IP)
const rateLimitMap = new Map(); // ip -> { count, resetAt }
function checkRateLimit(ip, max = 20, windowMs = 60 * 1000) {
  const now = Date.now();
  const entry = rateLimitMap.get(ip);
  if (!entry || now > entry.resetAt) {
    rateLimitMap.set(ip, { count: 1, resetAt: now + windowMs });
    return { allowed: true, remaining: max - 1 };
  }
  entry.count++;
  if (entry.count > max) {
    return { allowed: false, remaining: 0, retryAfter: Math.ceil((entry.resetAt - now) / 1000) };
  }
  return { allowed: true, remaining: max - entry.count };
}
// Cleanup every 5 min
setInterval(() => {
  const now = Date.now();
  for (const [k, v] of rateLimitMap) if (now > v.resetAt) rateLimitMap.delete(k);
}, 5 * 60 * 1000).unref();

/* ------------------------------------------------------------------ */
/* HTTP plumbing                                                       */
/* ------------------------------------------------------------------ */
function sendJson(res, code, obj) {
  const headers = Object.assign(
    { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' },
    securityHeaders()
  );
  res.writeHead(code, headers);
  res.end(JSON.stringify(obj));
}
function readBody(req, limit) {
  const max = limit || 2e6;
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', c => {
      data += c;
      if (data.length > max) {
        const err = new Error('body too large');
        err.tooLarge = true;
        reject(err);
        req.destroy();
      }
    });
    req.on('end', () => {
      if (!data) return resolve({});
      try { resolve(JSON.parse(data)); } catch (e) { reject(new Error('invalid JSON')); }
    });
    req.on('error', reject);
  });
}
function getStatic(req, res, urlPath) {
  let decoded;
  try { decoded = decodeURIComponent(urlPath); } catch (e) { decoded = urlPath; }
  const relativePath = decoded === '/' ? '/index.html' : decoded;
  // Prevent null bytes
  if (relativePath.includes('\0')) { res.writeHead(400, Object.assign({ 'Content-Type': 'text/plain' }, securityHeaders())); return res.end('bad request'); }
  // Resolve against PUBLIC_DIR and ensure containment
  const safeJoined = path.resolve(PUBLIC_DIR, '.' + path.normalize(relativePath));
  if (!safeJoined.startsWith(PUBLIC_DIR + path.sep) && safeJoined !== PUBLIC_DIR) {
    res.writeHead(403, Object.assign({ 'Content-Type': 'text/plain' }, securityHeaders()));
    return res.end('forbidden');
  }
  fs.stat(safeJoined, (err, stat) => {
    if (err || !stat.isFile()) {
      if (relativePath === '/' || relativePath === '/index.html') {
        const indexFile = path.join(PUBLIC_DIR, 'index.html');
        fs.readFile(indexFile, (err2, buf) => {
          if (err2) { res.writeHead(404, Object.assign({ 'Content-Type': 'text/plain' }, securityHeaders())); return res.end('not found'); }
          res.writeHead(200, Object.assign({ 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' }, securityHeaders()));
          res.end(buf);
        });
        return;
      }
      res.writeHead(404, Object.assign({ 'Content-Type': 'text/plain' }, securityHeaders()));
      return res.end('not found');
    }
    fs.readFile(safeJoined, (err2, buf) => {
      if (err2) { res.writeHead(404, Object.assign({ 'Content-Type': 'text/plain' }, securityHeaders())); return res.end('not found'); }
      const ext = path.extname(safeJoined).toLowerCase();
      const mime = { '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon', '.webmanifest': 'application/manifest+json; charset=utf-8', '.json': 'application/json; charset=utf-8' }[ext] || 'application/octet-stream';
      res.writeHead(200, Object.assign({ 'Content-Type': mime, 'Cache-Control': 'no-store' }, securityHeaders()));
      res.end(buf);
    });
  });
}
function outboxPage(res) {
  const hubEnabled = hubspot.isEnabled(process.env);
  const rows = hubSpotOutbox.map((e, i) => {
    const v = e.voice_call || {};
    const voice = v.provider ? escHtml(v.provider) + ' / ' + escHtml(v.mode || '') + (v.turns ? ' (' + v.turns + ' turns)' : '') : 'typed (no voice call)';
    const hub = e.hubspot ? (e.hubspot.dealId ? 'deal ' + escHtml(e.hubspot.dealId) : e.hubspot.mocked ? 'mock' : escHtml(e.hubspot.contactId || '')) : escHtml(e.contact_id);
    // Phase 3: the truth about the emailed PDF, exactly as Resend answered it.
    const pdfEmail = e.pdf_email;
    const mail = !pdfEmail
      ? 'not attempted'
      : pdfEmail.sent
        ? '✅ sent to ' + escHtml(pdfEmail.to || '')
        : '⚠️ not sent' + (pdfEmail.error ? ': ' + escHtml(String(pdfEmail.error).slice(0, 140)) : '');
    return '<tr><td>' + (i + 1) + '</td><td>' + escHtml(e.email) + '</td><td>' + hub + '</td><td>' + escHtml(e.industry || '') + '</td><td>' + voice + '</td><td>' + mail + '</td><td>' + escHtml(e.created_at) + '</td></tr>';
  }).join('');
  const banner = hubEnabled
    ? '<p style="background:#ecfdf5;border:1px solid #6ee7b7;padding:10px;border-radius:8px">✅ HubSpot live push is <b>enabled</b> (HUBSPOT_ACCESS_TOKEN is set). New delivers create a real Contact + Deal. Mock entries below are from before the token was set or from failed pushes.</p>'
    : '<p style="background:#fffbeb;border:1px solid #fcd34d;padding:10px;border-radius:8px">⚠️ HubSpot live push is <b>disabled</b> (no HUBSPOT_ACCESS_TOKEN). Deliveries are logged as <code>[hubspot-mock]</code> and shown here only. Set HUBSPOT_ACCESS_TOKEN and restart to go live.</p>';
  const html = '<!doctype html><meta charset="utf-8"><title>HubSpot outbox (dev)</title><style>body{font:14px/1.5 system-ui;background:#f6f7f9;margin:0;padding:24px}h1{font-size:18px}table{border-collapse:collapse;background:#fff;width:100%;max-width:1100px}td,th{border:1px solid #e5e7eb;padding:8px;text-align:left}pre{background:#111827;color:#d1d5db;padding:12px;border-radius:8px;overflow:auto;max-width:1100px}</style><h1>HubSpot lead outbox (local dev)</h1>' + banner + '<p>Every deliver step pushes a lead here and to the console. On Netlify the same payload is logged to the function logs. The <b>voice_call</b> block records how the discovery call was run (provider, models, turns, and whether the three required fields were still missing when the call ended). When live, the HubSpot contact ID replaces the mock ID.</p><table><tr><th>#</th><th>Email</th><th>HubSpot ID</th><th>Industry</th><th>Discovery call</th><th>PDF emailed</th><th>Pushed at</th></tr>' + rows + '</table><h2>Raw payloads</h2><pre>' + escHtml(JSON.stringify(hubSpotOutbox, null, 2)) + '</pre>';
  res.writeHead(200, Object.assign({ 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' }, securityHeaders()));
  res.end(html);
}

/* Shared route logic */
async function handleApi(req, res, url) {
  const route = url.pathname;
  const method = req.method;
  const ip = req.socket.remoteAddress || 'unknown';

  if (method === 'GET' && route === '/api/health') return sendJson(res, 200, { ok: true, service: 'pipelinesync-ai-prototype', version: '0.3', mode: 'local', hubspot: hubspot.isEnabled(process.env), scheduler: !!process.env.SCHEDULER_LINK, anthropic: anthropic.isEnabled(process.env) });
  if (method === 'GET' && route === '/api/config') {
    // Public, safe config for the frontend (scheduler link is public, never the token)
    const link = String(process.env.SCHEDULER_LINK || '').trim();
    return sendJson(res, 200, { ok: true, schedulerLink: link || null, hubspotEnabled: hubspot.isEnabled(process.env), aiEnabled: anthropic.isEnabled(process.env) });
  }
  if (method === 'GET' && route === '/dev/outbox') return outboxPage(res);

  /* Entry gate: name + email, no password. /api/auth/login is kept as an alias so any
     already-deployed client or bookmarked redirect still reaches the same handler. */
  if (method === 'POST' && (route === '/api/auth/start' || route === '/api/auth/login')) {
    const rl = checkRateLimit('start:' + ip, 20, 60 * 1000);
    if (!rl.allowed) {
      res.writeHead(429, Object.assign({ 'Content-Type': 'application/json; charset=utf-8', 'Retry-After': String(rl.retryAfter) }, securityHeaders()));
      return res.end(JSON.stringify({ error: 'Too many attempts. Please wait ' + rl.retryAfter + 's.' }));
    }
    const body = await readBody(req);
    const entry = core.validateEntry(body);
    if (!entry.ok) return sendJson(res, 400, { error: entry.error });
    try {
      const lead = await leads.createLead(entry.name, entry.email, { env: process.env });
      if (lead) await leads.addEvent(lead.id, 'lead_signed_up', { source: 'pipelinesync_ai' }, { env: process.env });
      // HubSpot at capture must never fail the entry gate.
      const hubspotInfo = await hubspot.captureLead({
        email: entry.email, name: entry.name, env: process.env, fetchImpl: fetch
      });
      const token = core.signToken({
        email: entry.email, name: entry.name,
        lead_id: lead && lead.id ? lead.id : null,
        hubspot_contact_id: hubspotInfo && hubspotInfo.contactId ? hubspotInfo.contactId : null,
        exp: Date.now() + core.TOKEN_TTL_MS
      });
      return sendJson(res, 200, {
        ok: true, token,
        user: {
          name: entry.name, email: entry.email,
          first_name: core.firstNameOf(entry.name), initials: core.initialsOf(entry.name),
          lead_id: lead && lead.id ? lead.id : null
        },
        hubspot: hubspotInfo
      });
    } catch (e) {
      console.error('[entry] could not create lead:', e.message);
      return sendJson(res, 503, { error: 'We could not save your details right now. Please try again in a moment.' });
    }
  }
  if (method === 'POST' && route === '/api/auth/logout') {
    await readBody(req);
    return sendJson(res, 200, { ok: true });
  }

  /* Voice routes first: they carry audio, so they get the larger body limit, and the shared
     handler (lib/voice-api.js) verifies the token itself, exactly as the Netlify function does.
     Voice turns cost money per call, so they are rate limited per user and per IP, like login. */
  if (method === 'POST' && route.startsWith('/api/voice/')) {
    const sub = route.slice('/api/voice/'.length);
    const perMinute = parseInt(process.env.VOICE_RATE_PER_MIN, 10) || rateLimitFor(sub);
    const rl = checkRateLimit('voice:' + sub + ':' + ip, perMinute, 60 * 1000);
    if (!rl.allowed) {
      res.writeHead(429, Object.assign({ 'Content-Type': 'application/json; charset=utf-8', 'Retry-After': String(rl.retryAfter) }, securityHeaders()));
      return res.end(JSON.stringify({ error: 'Too many voice requests. Wait ' + rl.retryAfter + 's and try again.' }));
    }
    let body;
    try { body = await readBody(req, 8 * 1024 * 1024); }
    catch (e) { return sendJson(res, e.tooLarge ? 413 : 400, { error: e.tooLarge ? 'That recording is too large. Keep each answer short, or type instead.' : 'Bad request body.' }); }
    const out = await handleVoice(sub, body, { env: process.env, fetchImpl: fetch, ip });
    return sendJson(res, out.status, out.body);
  }

  // Authenticated routes: token is in the JSON body (client always sends it)
  const authBody = await readBody(req);
  // GET /api/generate/status carries the token in the query string (the poll loop is a GET).
  const payload = core.verifyToken(authBody.token || url.searchParams.get('token'));
  if (!payload) return sendJson(res, 401, { error: 'Your session has ended. Enter your name and email to start again.' });

  if (method === 'POST' && route === '/api/lead/progress') {
    if (!payload.lead_id || !leads.isEnabled(process.env)) return sendJson(res, 200, { ok: true, stored: false });
    const allowed = new Set(['discovery_started', 'discovery_completed', 'consultation_requested']);
    const status = String(authBody.status || '');
    if (!allowed.has(status)) return sendJson(res, 400, { error: 'Invalid lead progress status.' });
    const now = new Date().toISOString();
    const patch = { status };
    if (status === 'discovery_started') patch.discovery_started_at = now;
    if (status === 'discovery_completed') patch.discovery_completed_at = now;
    if (status === 'consultation_requested') patch.consultation_requested_at = now;
    await leads.updateLead(payload.lead_id, patch, { env: process.env });
    if (status === 'discovery_started' || status === 'discovery_completed') {
      await leads.saveSession(payload.lead_id, {
        status: status === 'discovery_completed' ? 'completed' : 'in_progress',
        answers: Array.isArray(authBody.answers) ? authBody.answers : undefined,
        voice_metadata: authBody.voice_meta || undefined,
        started_at: status === 'discovery_started' ? now : undefined,
        completed_at: status === 'discovery_completed' ? now : undefined
      }, { env: process.env });
    }
    await leads.addEvent(payload.lead_id, status, {}, { env: process.env });
    return sendJson(res, 200, { ok: true, stored: true });
  }

  /* The /api/ai/* arbitrary-prompt passthrough is removed (Phase 2): Claude is only
     reachable through /api/extract and /api/generate, with server-side prompts. */
  if (route === '/api/ai' || route.startsWith('/api/ai/')) {
    return sendJson(res, 404, { error: 'Not found.' });
  }

  if (method === 'POST' && route === '/api/extract') {
    const answers = Array.isArray(authBody.answers) ? authBody.answers : [];
    if (answers.length > 20) return sendJson(res, 400, { error: 'Too many answers.' });
    for (const a of answers) {
      if (!a || typeof a.id !== 'string' || typeof a.text !== 'string') return sendJson(res, 400, { error: 'Invalid answer format.' });
      if (a.id.length > 100 || a.text.length > 5000) return sendJson(res, 400, { error: 'Answer too long (max 5000 chars).' });
    }
    const result = await aiPipeline.runExtract(answers, { env: process.env });
    return sendJson(res, 200, {
      ok: true, fields: result.fields,
      filledCount: result.filledCount, totalCount: result.totalCount, source: result.source
    });
  }

  /* Blueprint generation: same job contract as the deployed background function, so the
     client polls /api/generate/status in both environments. Locally the job runs inline. */
  if (method === 'POST' && route === '/api/generate') {
    const fields = authBody.fields || {};
    try { if (JSON.stringify(fields).length > 100000) return sendJson(res, 400, { error: 'Fields payload too large.' }); } catch (e) {}
    const v = blueprintSchema.validateGenerateFields(fields);
    if (!v.ok) {
      return sendJson(res, 400, {
        error: 'Some required answers are missing or invalid. Correct them on the review screen and try again.',
        fieldErrors: v.fieldErrors
      });
    }
    const jobId = jobStore.newJobId();
    await generateJob.setStep(jobId, 'validating', { source: null }, { env: process.env });
    generateJob.runJob(jobId, fields, payload, { env: process.env });
    return sendJson(res, 202, { ok: true, jobId, status: 'accepted', pollUrl: '/api/generate/status?jobId=' + jobId });
  }

  if ((method === 'GET' || method === 'POST') && route === '/api/generate/status') {
    const jobId = String(authBody.jobId || url.searchParams.get('jobId') || '');
    const rec = await jobStore.get(jobId, { env: process.env });
    if (!rec) return sendJson(res, 404, { error: 'That blueprint job is unknown or has expired. Generate again.' });
    const out = {
      ok: true, jobId: rec.jobId, status: rec.status, step: rec.step || null,
      label: rec.label || null, progress: typeof rec.progress === 'number' ? rec.progress : 0,
      source: rec.source || null
    };
    if (rec.status === 'done') out.blueprint = rec.blueprint;
    if (rec.status === 'error') { out.error = rec.error || 'Generation failed.'; if (rec.fieldErrors) out.fieldErrors = rec.fieldErrors; }
    return sendJson(res, 200, out);
  }

  if (method === 'POST' && route === '/api/deliver') {
    // Phase 3: 5 unlocks per minute per IP, the same limit the Netlify function applies.
    const rl = deliverCore.checkDeliverRateLimit(ip, process.env);
    if (!rl.allowed) {
      res.writeHead(429, Object.assign({ 'Content-Type': 'application/json; charset=utf-8', 'Retry-After': String(rl.retryAfter) }, securityHeaders()));
      return res.end(JSON.stringify({ error: 'Too many unlock attempts. Please wait ' + rl.retryAfter + 's and try again.' }));
    }
    // Shared with netlify/functions/deliver.js: PDF (C), the Resend email (Phase 3), HubSpot (D).
    const out = await deliverCore.deliver({ body: authBody, env: process.env, fetchImpl: fetch });
    // Local-only extra: the /dev/outbox view of what was pushed (Netlify uses the function logs).
    const meta = out.meta || {};
    if (out.statusCode === 200 && meta.mockLead) {
      const live = meta.hubspotResult && meta.hubspotResult.enabled && !meta.hubspotResult.mocked;
      hubSpotOutbox.push(Object.assign({}, meta.mockLead, {
        contact_id: meta.contactId,
        hubspot: live ? { contactId: meta.contactId, dealId: meta.hubspotResult.dealId, mocked: false } : { mocked: true },
        pdf_email: meta.emailResult ? { sent: !!meta.emailResult.sent, to: meta.emailResult.to || null, error: meta.emailResult.error || null } : null,
        created_at: new Date().toISOString()
      }));
    }
    return sendJson(res, out.statusCode, out.body);
  }

  return sendJson(res, 404, { error: 'Unknown route' });
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://' + (req.headers.host || 'localhost'));
  try {
    if (url.pathname.startsWith('/api/') || url.pathname === '/dev/outbox') return await handleApi(req, res, url);
    if (req.method !== 'GET') {
      res.writeHead(405, Object.assign({ 'Content-Type': 'text/plain' }, securityHeaders()));
      return res.end('method not allowed');
    }
    return getStatic(req, res, url.pathname);
  } catch (e) {
    console.error('[error]', req.method, url.pathname, e.message);
    return sendJson(res, 500, { error: e.message || 'Server error' });
  }
});
server.listen(PORT, HOST, () => {
  console.log('PipelineSync AI prototype (local) listening on http://' + HOST + ':' + PORT);
  console.log('Dev outbox: http://' + HOST + ':' + PORT + '/dev/outbox');
  const vm = voice.mode(process.env);
  console.log('Discovery call voice: ' + vm.mode +
    (vm.mode === 'openai'
      ? ' (chat ' + vm.models.chat + ', speech ' + vm.models.tts + ' voice ' + vm.voice + ', transcription ' + vm.models.stt + ')'
      : ' - ' + vm.why));
  const rt = vm.realtime || {};
  console.log(rt.enabled
    ? 'Continuous call: OpenAI Realtime ' + rt.model + ' voice ' + rt.voice + ' (' + rt.vad +
        (rt.vad === 'semantic_vad' ? ', eagerness ' + rt.eagerness : ', silence ' + rt.silenceMs + 'ms') +
      ') - one WebRTC session carries the whole call'
    : 'Continuous call: step by step instead - ' + (rt.why || 'unavailable'));
  if (!process.env.PS_TOKEN_SECRET) console.log('Note: PS_TOKEN_SECRET not set; using the built-in dev secret (fine for local + test deploys). Set PS_TOKEN_SECRET in production.');
});
