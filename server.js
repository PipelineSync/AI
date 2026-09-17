'use strict';
/*
 * PipelineSync AI - LOCAL dev server (Node, zero dependencies).
 * Run: node server.js   (http://0.0.0.0:8080)
 *
 * The deployed prototype (GitHub -> Netlify) runs the same logic from
 * netlify/functions/*.js against the same shared core (lib/core.js).
 * Local extras: in-memory HubSpot outbox view at /dev/outbox.
 */
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const core = require('./lib/core');

const PORT = process.env.PORT || 8080;
const HOST = '0.0.0.0';
const PUBLIC_DIR = path.join(__dirname, 'public');

const hubSpotOutbox = []; // local-only stand-in view of Function D pushes

/* ------------------------------------------------------------------ */
/* HTTP plumbing                                                       */
/* ------------------------------------------------------------------ */
function sendJson(res, code, obj) {
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
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
  const file = path.join(PUBLIC_DIR, path.normalize(urlPath === '/' ? '/index.html' : urlPath).replace(/^([.][.][\/\\])+/, ''));
  if (!file.startsWith(PUBLIC_DIR)) { res.writeHead(403); return res.end('forbidden'); }
  fs.readFile(file, (err, buf) => {
    if (err) { res.writeHead(404, { 'Content-Type': 'text/plain' }); return res.end('not found'); }
    const ext = path.extname(file).toLowerCase();
    const mime = { '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon' }[ext] || 'application/octet-stream';
    res.writeHead(200, { 'Content-Type': mime, 'Cache-Control': 'no-store' });
    res.end(buf);
  });
}
function outboxPage(res) {
  const rows = hubSpotOutbox.map((e, i) => '<tr><td>' + (i + 1) + '</td><td>' + e.email + '</td><td>' + e.contact_id + '</td><td>' + (e.industry || '') + '</td><td>' + e.created_at + '</td></tr>').join('');
  const html = '<!doctype html><meta charset="utf-8"><title>HubSpot outbox (dev)</title><style>body{font:14px/1.5 system-ui;background:#f6f7f9;margin:0;padding:24px}h1{font-size:18px}table{border-collapse:collapse;background:#fff;width:100%;max-width:900px}td,th{border:1px solid #e5e7eb;padding:8px;text-align:left}pre{background:#111827;color:#d1d5db;padding:12px;border-radius:8px;overflow:auto;max-width:900px}</style><h1>HubSpot lead outbox (mock Function D, local dev)</h1><p>Every deliver step pushes a lead here and to the console. On Netlify the same payload is logged to the function logs.</p><table><tr><th>#</th><th>Email</th><th>Contact ID</th><th>Industry</th><th>Pushed at</th></tr>' + rows + '</table><h2>Raw payloads</h2><pre>' + JSON.stringify(hubSpotOutbox, null, 2).replace(/</g, '&lt;') + '</pre>';
  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
  res.end(html);
}

/* Shared route logic: returns a response object or null for "not this route".
   Kept identical in shape to netlify/functions so behaviour matches in prod. */
async function handleApi(req, res, url) {
  const route = url.pathname;
  const method = req.method;

  if (method === 'GET' && route === '/api/health') return sendJson(res, 200, { ok: true, service: 'pipelinesync-ai-prototype', version: '0.2', mode: 'local' });
  if (method === 'GET' && route === '/dev/outbox') return outboxPage(res);

  if (method === 'POST' && route === '/api/auth/login') {
    const body = await readBody(req);
    const email = String(body.email || '').trim().toLowerCase();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return sendJson(res, 400, { error: 'Enter a valid email address.' });
    if (String(body.password || '').length < 4) return sendJson(res, 400, { error: 'Password must be at least 4 characters (prototype rule).' });
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
    const fields = core.extract(authBody.answers || []);
    const all = Object.keys(fields);
    const filled = all.filter(k => JSON.stringify(fields[k]) !== 'null' && JSON.stringify(fields[k]) !== '[]' && JSON.stringify(fields[k]) !== '""');
    return sendJson(res, 200, { ok: true, fields, filledCount: filled.length, totalCount: all.length });
  }

  if (method === 'POST' && route === '/api/generate') {
    const fields = authBody.fields || {};
    const bp = core.generate(fields);
    return sendJson(res, 200, { ok: true, blueprint: bp });
  }

  if (method === 'POST' && route === '/api/deliver') {
    const bp = authBody.blueprint;
    if (!bp || !bp.meta || !bp.meta.verticalLabel) return sendJson(res, 400, { error: 'No blueprint in request. Generate the blueprint before unlocking the PDF.' });
    const email = String(authBody.email || '').trim().toLowerCase();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return sendJson(res, 400, { error: 'Enter a valid email to unlock the PDF.' });
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
    if (req.method !== 'GET') { res.writeHead(405); return res.end(); }
    return getStatic(req, res, url.pathname);
  } catch (e) {
    console.error('[error]', req.method, url.pathname, e.message);
    return sendJson(res, 500, { error: e.message || 'Server error' });
  }
});
server.listen(PORT, HOST, () => {
  console.log('PipelineSync AI prototype (local) listening on http://' + HOST + ':' + PORT);
  console.log('Dev outbox: http://' + HOST + ':' + PORT + '/dev/outbox');
  if (!process.env.PS_TOKEN_SECRET) console.log('Note: PS_TOKEN_SECRET not set; using the built-in dev secret (fine for local + test deploys).');
});
