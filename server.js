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
  return {
    'X-Content-Type-Options': 'nosniff',
    'X-Frame-Options': 'DENY',
    'Referrer-Policy': 'strict-origin-when-cross-origin',
    'Permissions-Policy': 'microphone=(self), camera=()',
    'Content-Security-Policy': "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; connect-src 'self'; font-src 'self'; object-src 'none'; base-uri 'self'; frame-ancestors 'none'",
  };
}

// Simple in-memory rate limiter for login (per IP)
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
function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', c => { data += c; if (data.length > 2e6) { reject(new Error('body too large')); req.destroy(); } });
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
      const mime = { '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon' }[ext] || 'application/octet-stream';
      res.writeHead(200, Object.assign({ 'Content-Type': mime, 'Cache-Control': 'no-store' }, securityHeaders()));
      res.end(buf);
    });
  });
}
function outboxPage(res) {
  const rows = hubSpotOutbox.map((e, i) =>
    '<tr><td>' + (i + 1) + '</td><td>' + escHtml(e.email) + '</td><td>' + escHtml(e.contact_id) + '</td><td>' + escHtml(e.industry || '') + '</td><td>' + escHtml(e.created_at) + '</td></tr>'
  ).join('');
  const html = '<!doctype html><meta charset="utf-8"><title>HubSpot outbox (dev)</title><style>body{font:14px/1.5 system-ui;background:#f6f7f9;margin:0;padding:24px}h1{font-size:18px}table{border-collapse:collapse;background:#fff;width:100%;max-width:900px}td,th{border:1px solid #e5e7eb;padding:8px;text-align:left}pre{background:#111827;color:#d1d5db;padding:12px;border-radius:8px;overflow:auto;max-width:900px}</style><h1>HubSpot lead outbox (mock Function D, local dev)</h1><p>Every deliver step pushes a lead here and to the console. On Netlify the same payload is logged to the function logs.</p><table><tr><th>#</th><th>Email</th><th>Contact ID</th><th>Industry</th><th>Pushed at</th></tr>' + rows + '</table><h2>Raw payloads</h2><pre>' + escHtml(JSON.stringify(hubSpotOutbox, null, 2)) + '</pre>';
  res.writeHead(200, Object.assign({ 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' }, securityHeaders()));
  res.end(html);
}

/* Shared route logic */
async function handleApi(req, res, url) {
  const route = url.pathname;
  const method = req.method;
  const ip = req.socket.remoteAddress || 'unknown';

  if (method === 'GET' && route === '/api/health') return sendJson(res, 200, { ok: true, service: 'pipelinesync-ai-prototype', version: '0.2', mode: 'local' });
  if (method === 'GET' && route === '/dev/outbox') return outboxPage(res);

  if (method === 'POST' && route === '/api/auth/login') {
    const rl = checkRateLimit('login:' + ip, 20, 60 * 1000);
    if (!rl.allowed) {
      res.writeHead(429, Object.assign({ 'Content-Type': 'application/json; charset=utf-8', 'Retry-After': String(rl.retryAfter) }, securityHeaders()));
      return res.end(JSON.stringify({ error: 'Too many login attempts. Please wait ' + rl.retryAfter + 's.' }));
    }
    const body = await readBody(req);
    const email = String(body.email || '').trim().toLowerCase();
    const password = String(body.password || '');
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return sendJson(res, 400, { error: 'Enter a valid email address.' });
    if (email.length > 254) return sendJson(res, 400, { error: 'Email too long.' });
    if (password.length < 4) return sendJson(res, 400, { error: 'Password must be at least 4 characters (prototype rule).' });
    if (password.length > 128) return sendJson(res, 400, { error: 'Password too long.' });
    const name = core.loginNameFor(email);
    const token = core.signToken({ email, name, exp: Date.now() + core.TOKEN_TTL_MS });
    return sendJson(res, 200, { ok: true, token, user: { name, email } });
  }
  if (method === 'POST' && route === '/api/auth/logout') {
    await readBody(req);
    return sendJson(res, 200, { ok: true });
  }

  // Authenticated routes: token is in the JSON body (client always sends it)
  const authBody = await readBody(req);
  const payload = core.verifyToken(authBody.token);
  if (!payload) return sendJson(res, 401, { error: 'Not signed in.' });

  if (method === 'POST' && route === '/api/extract') {
    const answers = Array.isArray(authBody.answers) ? authBody.answers : [];
    if (answers.length > 20) return sendJson(res, 400, { error: 'Too many answers.' });
    for (const a of answers) {
      if (!a || typeof a.id !== 'string' || typeof a.text !== 'string') return sendJson(res, 400, { error: 'Invalid answer format.' });
      if (a.id.length > 100 || a.text.length > 5000) return sendJson(res, 400, { error: 'Answer too long (max 5000 chars).' });
    }
    const fields = core.extract(answers);
    const all = Object.keys(fields);
    const filled = all.filter(k => JSON.stringify(fields[k]) !== 'null' && JSON.stringify(fields[k]) !== '[]' && JSON.stringify(fields[k]) !== '""');
    return sendJson(res, 200, { ok: true, fields, filledCount: filled.length, totalCount: all.length });
  }

  if (method === 'POST' && route === '/api/generate') {
    const fields = authBody.fields || {};
    try { if (JSON.stringify(fields).length > 100000) return sendJson(res, 400, { error: 'Fields payload too large.' }); } catch (e) {}
    const bp = core.generate(fields);
    return sendJson(res, 200, { ok: true, blueprint: bp });
  }

  if (method === 'POST' && route === '/api/deliver') {
    const bp = authBody.blueprint;
    if (!bp || !bp.meta || !bp.meta.verticalLabel) return sendJson(res, 400, { error: 'No blueprint in request. Generate the blueprint before unlocking the PDF.' });
    const email = String(authBody.email || '').trim().toLowerCase();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return sendJson(res, 400, { error: 'Enter a valid email to unlock the PDF.' });
    if (email.length > 254) return sendJson(res, 400, { error: 'Email too long.' });
    if (authBody.consent !== true) return sendJson(res, 400, { error: 'Please tick the consent box before we send the PDF.' });
    const buffer = core.buildPdf(bp);
    const lead = core.makeLeadPayload(email, payload.name, authBody.fields || null, bp);
    hubSpotOutbox.push(lead);
    console.log('[hubspot-mock] lead push: ' + JSON.stringify(lead));
    return sendJson(res, 200, {
      ok: true, contact_id: lead.contact_id, lead_pushed: true,
      filename: core.pdfFilename(bp), pdf_base64: buffer.toString('base64')
    });
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
  if (!process.env.PS_TOKEN_SECRET) console.log('Note: PS_TOKEN_SECRET not set; using the built-in dev secret (fine for local + test deploys). Set PS_TOKEN_SECRET in production.');
});
