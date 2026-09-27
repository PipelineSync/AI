'use strict';
/*
 * Tests for Cloudflare Turnstile at the entry gate, env-gated.
 * - unset: behaviour unchanged, no token required
 * - pass: stubbed siteverify returns success, start succeeds
 * - fail: stubbed siteverify returns failure, start returns 403
 *
 * Covers both the Netlify function handler and the local dev server (via harness),
 * plus the public config endpoint.
 */

const http = require('http');
const { startServer } = require('./harness');
const turnstile = require('../lib/turnstile');
const core = require('../lib/core');

const TEST_SECRET = 'test-secret-0123456789abcdef';
process.env.PS_TOKEN_SECRET = TEST_SECRET;

let failures = 0;
const ok = (cond, msg) => { console.log((cond ? '  PASS  ' : '  FAIL  ') + msg); if (!cond) failures++; };
const section = t => console.log('\n' + t);

function stubRes(status, body) {
  const text = body == null ? '' : (typeof body === 'string' ? body : JSON.stringify(body));
  return {
    ok: status >= 200 && status < 300,
    status,
    async json() { try { return JSON.parse(text); } catch (e) { return {}; } },
    async text() { return text; }
  };
}

/* Mock Cloudflare verify server */
function startMockVerify(port, handler) {
  const server = http.createServer((req, res) => {
    if (req.method !== 'POST') { res.writeHead(405); return res.end(); }
    let data = '';
    req.on('data', c => data += c);
    req.on('end', () => {
      const params = new URLSearchParams(data);
      const secret = params.get('secret');
      const response = params.get('response');
      const remoteip = params.get('remoteip');
      const result = handler({ secret, response, remoteip });
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(result));
    });
  });
  return new Promise((resolve, reject) => {
    server.listen(port, '127.0.0.1', () => resolve(server));
    server.on('error', reject);
  });
}

(async () => {
  /* ---- lib/turnstile unit with stubbed fetch ---- */
  section('lib/turnstile unit - unset (no env)');
  {
    const env = {};
    ok(turnstile.isEnabled(env) === false, 'isEnabled false when unset');
    const v = await turnstile.verify('', { env });
    ok(v.ok === true, 'verify returns ok when not enabled (behaviour unchanged)');
  }

  section('lib/turnstile unit - stubbed siteverify pass/fail');
  {
    const env = { TURNSTILE_SITE_KEY: 'sitekey123', TURNSTILE_SECRET_KEY: 'secret123' };
    const passFetch = async () => stubRes(200, { success: true });
    const failFetch = async () => stubRes(200, { success: false, 'error-codes': ['invalid-input-response'] });

    const ok1 = await turnstile.verify('valid-token', { env, fetchImpl: passFetch, remoteIp: '1.2.3.4' });
    ok(ok1.ok === true, 'valid token with success response -> ok');

    const bad1 = await turnstile.verify('bad-token', { env, fetchImpl: failFetch });
    ok(bad1.ok === false && /verification failed/i.test(bad1.error), 'invalid token -> fail with clear message');

    const missing = await turnstile.verify('', { env, fetchImpl: passFetch });
    ok(missing.ok === false && /required/i.test(missing.error), 'missing token when enabled -> 403 style error');
  }

  /* ---- Netlify function start.js with stubbed fetch ---- */
  section('netlify/functions/start.js - turnstile pass/fail/unset');

  const startFn = require('../netlify/functions/start.js').handler;
  const configFn = require('../netlify/functions/config.js').handler;

  // Unset: no turnstile env, should succeed without token
  {
    delete process.env.TURNSTILE_SITE_KEY;
    delete process.env.TURNSTILE_SECRET_KEY;
    const res = await startFn({ httpMethod: 'POST', path: '/api/auth/start', headers: {}, body: JSON.stringify({ name: 'Allen Reyes', email: 'allen@pipelinesync.ai' }) });
    ok(res.statusCode === 200, 'unset: start returns 200 without token');
  }

  // With env set, stubbed success
  {
    process.env.TURNSTILE_SITE_KEY = 'test-site-key';
    process.env.TURNSTILE_SECRET_KEY = 'test-secret-key';
    const origFetch = globalThis.fetch;
    globalThis.fetch = async (url, init) => {
      const u = String(url);
      if (u.includes('challenges.cloudflare.com')) {
        const body = String(init && init.body || '');
        const p = new URLSearchParams(body);
        if (p.get('response') === 'valid-token') return stubRes(200, { success: true });
        return stubRes(200, { success: false, 'error-codes': ['invalid-input-response'] });
      }
      // HubSpot mock: no calls needed, but return empty to avoid errors
      return stubRes(200, { total: 0, results: [] });
    };
    try {
      const good = await startFn({ httpMethod: 'POST', path: '/api/auth/start', headers: { 'x-nf-client-connection-ip': '1.2.3.4' }, body: JSON.stringify({ name: 'Allen', email: 'allen@pipelinesync.ai', turnstileToken: 'valid-token' }) });
      ok(good.statusCode === 200 && JSON.parse(good.body).token, 'pass: start returns 200 with valid token');

      const bad = await startFn({ httpMethod: 'POST', path: '/api/auth/start', headers: {}, body: JSON.stringify({ name: 'Allen', email: 'allen@pipelinesync.ai', turnstileToken: 'bad-token' }) });
      ok(bad.statusCode === 403, 'fail: start returns 403 with invalid token');
      ok(/Turnstile verification failed/.test(JSON.parse(bad.body).error), 'fail: clear message');

      const missing = await startFn({ httpMethod: 'POST', path: '/api/auth/start', headers: {}, body: JSON.stringify({ name: 'Allen', email: 'allen@pipelinesync.ai' }) });
      ok(missing.statusCode === 403, 'fail: start returns 403 when token missing and Turnstile enabled');
    } finally {
      globalThis.fetch = origFetch;
    }
    delete process.env.TURNSTILE_SITE_KEY;
    delete process.env.TURNSTILE_SECRET_KEY;
  }

  // Config returns site key when enabled
  {
    process.env.TURNSTILE_SITE_KEY = 'public-site-key';
    process.env.TURNSTILE_SECRET_KEY = 'secret';
    const res = await configFn({ httpMethod: 'GET', path: '/api/config' });
    const j = JSON.parse(res.body);
    ok(j.turnstileSiteKey === 'public-site-key', 'config returns turnstileSiteKey when both envs set');
    delete process.env.TURNSTILE_SITE_KEY;
    delete process.env.TURNSTILE_SECRET_KEY;
    const res2 = await configFn({ httpMethod: 'GET', path: '/api/config' });
    const j2 = JSON.parse(res2.body);
    ok(!j2.turnstileSiteKey, 'config does not return turnstileSiteKey when unset');
  }

  /* ---- Local dev server via harness with mock verify server ---- */
  section('server.js - turnstile integration via harness');

  const mockPort = 8099;
  const mockServer = await startMockVerify(mockPort, ({ secret, response }) => {
    if (secret !== 'test-secret-key') return { success: false, 'error-codes': ['invalid-input-secret'] };
    if (response === 'valid-token') return { success: true };
    return { success: false, 'error-codes': ['invalid-input-response'] };
  });

  try {
    // Unset: server should allow without token
    {
      const srv = await startServer(8098, { TURNSTILE_SITE_KEY: '', TURNSTILE_SECRET_KEY: '', DEMO_MODE: 'true' });
      try {
        const r = await fetch(srv.base + '/api/auth/start', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: 'Allen', email: 'allen@pipelinesync.ai' }) });
        const j = await r.json();
        ok(r.status === 200 && j.token, 'server unset: 200 without token');
      } finally { srv.stop(); }
    }

    // Enabled: pass
    {
      const srv = await startServer(8097, {
        TURNSTILE_SITE_KEY: 'test-site-key',
        TURNSTILE_SECRET_KEY: 'test-secret-key',
        TURNSTILE_VERIFY_URL: `http://127.0.0.1:${mockPort}/siteverify`,
        DEMO_MODE: 'true',
        DELIVER_PER_EMAIL_DAY: '1000',
        PDF_EMAIL_DAILY_MAX: '1000'
      });
      try {
        const r = await fetch(srv.base + '/api/config');
        const j = await r.json();
        ok(j.turnstileSiteKey === 'test-site-key', 'server config returns site key');

        const good = await fetch(srv.base + '/api/auth/start', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ name: 'Allen', email: 'allen@pipelinesync.ai', turnstileToken: 'valid-token' })
        });
        const gj = await good.json();
        ok(good.status === 200 && gj.token, 'server pass: 200 with valid token');

        const bad = await fetch(srv.base + '/api/auth/start', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ name: 'Allen', email: 'allen@pipelinesync.ai', turnstileToken: 'bad-token' })
        });
        ok(bad.status === 403, 'server fail: 403 with bad token');
        const bj = await bad.json();
        ok(/Turnstile verification failed/.test(bj.error), 'server fail: clear message');
      } finally { srv.stop(); }
    }
  } finally {
    mockServer.close();
  }

  console.log('\n' + (failures === 0 ? 'TURNSTILE TESTS PASSED' : failures + ' FAILURE(S)'));
  process.exit(failures === 0 ? 0 : 1);
})().catch(e => { console.error('Turnstile test error:', e); process.exit(1); });
