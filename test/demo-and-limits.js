'use strict';
/*
 * Tests for:
 *  - Demo mode behind DEMO_MODE flag
 *  - Shared limits in Netlify Blobs with fallback (deliver-limits)
 *    - per-email daily cap
 *    - global daily cap
 *  - Idempotency and server-side blueprint (Phase 6)
 */

const { startServer } = require('./harness');
const core = require('../lib/core');
const deliverLimits = require('../lib/deliver-limits');

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

(async () => {
  section('Demo mode flag - config and start');

  const configFn = require('../netlify/functions/config.js').handler;
  const startFn = require('../netlify/functions/start.js').handler;

  {
    delete process.env.DEMO_MODE;
    const res = await configFn({ httpMethod: 'GET', path: '/api/config' });
    const j = JSON.parse(res.body);
    ok(!j.demoMode, 'unset: config does not return demoMode');

    const startRes = await startFn({ httpMethod: 'POST', path: '/api/auth/start', body: JSON.stringify({ name: 'Demo Owner', email: 'demo@pipelinesync.ai' }) });
    ok(startRes.statusCode === 403, 'unset: start rejects demo@pipelinesync.ai with 403');
    ok(/Demo account is not available/.test(JSON.parse(startRes.body).error), 'unset: clear message for demo rejection');
  }

  {
    process.env.DEMO_MODE = 'true';
    const res = await configFn({ httpMethod: 'GET', path: '/api/config' });
    const j = JSON.parse(res.body);
    ok(j.demoMode === true, 'enabled: config returns demoMode:true');

    const origFetch = globalThis.fetch;
    globalThis.fetch = async () => stubRes(200, { total: 0, results: [] });
    try {
      const startRes = await startFn({ httpMethod: 'POST', path: '/api/auth/start', body: JSON.stringify({ name: 'Demo Owner', email: 'demo@pipelinesync.ai' }) });
      ok(startRes.statusCode === 200, 'enabled: start allows demo@pipelinesync.ai');
    } finally {
      globalThis.fetch = origFetch;
    }
    delete process.env.DEMO_MODE;
  }

  {
    const srvOff = await startServer(8096, { DEMO_MODE: 'false' });
    try {
      const cfg = await (await fetch(srvOff.base + '/api/config')).json();
      ok(!cfg.demoMode, 'server unset: config no demoMode');
      const r = await fetch(srvOff.base + '/api/auth/start', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: 'Demo', email: 'demo@pipelinesync.ai' }) });
      ok(r.status === 403, 'server unset: rejects demo email');
    } finally { srvOff.stop(); }

    const srvOn = await startServer(8095, { DEMO_MODE: 'true' });
    try {
      const cfg = await (await fetch(srvOn.base + '/api/config')).json();
      ok(cfg.demoMode === true, 'server enabled: config demoMode true');
      const r = await fetch(srvOn.base + '/api/auth/start', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: 'Demo', email: 'demo@pipelinesync.ai' }) });
      const j = await r.json();
      ok(r.status === 200 && j.token, 'server enabled: allows demo email');
    } finally { srvOn.stop(); }
  }

  section('Deliver limits - per-email cap');

  deliverLimits._resetMemory();

  const envPerEmail = { DELIVER_PER_EMAIL_DAY: '3' };
  const testEmail = 'limit-test@example.com';

  {
    const check = await deliverLimits.checkPerEmail(testEmail, envPerEmail);
    ok(check.allowed && check.count === 0, 'per-email: 0 count allowed');
  }

  {
    await deliverLimits.incrementPerEmail(testEmail, envPerEmail);
    await deliverLimits.incrementPerEmail(testEmail, envPerEmail);
    await deliverLimits.incrementPerEmail(testEmail, envPerEmail);
    const check = await deliverLimits.checkPerEmail(testEmail, envPerEmail);
    ok(!check.allowed && check.count === 3, 'per-email: 3 count blocks 4th');
  }

  {
    const check = await deliverLimits.checkPerEmail('other@example.com', envPerEmail);
    ok(check.allowed && check.count === 0, 'per-email: different email unaffected');
  }

  deliverLimits._resetMemory();

  section('Deliver limits - global daily cap');

  const envGlobal = { PDF_EMAIL_DAILY_MAX: '2' };
  {
    const check = await deliverLimits.checkGlobal(envGlobal);
    ok(check.allowed && check.count === 0, 'global: 0 count allowed');
    await deliverLimits.incrementGlobal(envGlobal);
    const check2 = await deliverLimits.checkGlobal(envGlobal);
    ok(check2.allowed && check2.count === 1, 'global: 1 count allowed');
    await deliverLimits.incrementGlobal(envGlobal);
    const check3 = await deliverLimits.checkGlobal(envGlobal);
    ok(!check3.allowed && check3.count === 2, 'global: 2 count blocks (limit 2)');
  }

  deliverLimits._resetMemory();

  section('Deliver integration - per-email and global caps via function (jobId flow)');

  const deliverFn = require('../netlify/functions/deliver.js').handler;
  const jobs = require('../lib/job-store');
  const idem = require('../lib/deliver-idempotency');
  const persona = require('./personas.json').solar;
  const answers = Object.entries(persona.answers).map(([id, text]) => ({ id, text }));
  const fields = core.extract(answers);
  const blueprint = core.generate(fields);

  const token = core.signToken({
    email: 'cap-test@example.com',
    name: 'Cap Test',
    lead_id: null,
    hubspot_contact_id: null,
    exp: Date.now() + core.TOKEN_TTL_MS
  });

  function makeFetchStub() {
    const calls = [];
    const impl = async (url, init) => {
      const u = String(url);
      let body = null;
      try { body = init && init.body ? JSON.parse(init.body) : null; } catch (e) { body = init && init.body; }
      calls.push({ url: u, body });
      if (u.includes('api.resend.com')) return stubRes(200, { id: 're_test_1' });
      if (u.includes('api.hubapi.com')) {
        if (u.includes('/contacts/search')) return stubRes(200, { total: 0, results: [] });
        if (u.includes('/objects/contacts') && init.method === 'POST') return stubRes(200, { id: '101', properties: {} });
        if (u.includes('/objects/deals')) return stubRes(200, { id: '202', properties: {} });
        if (u.includes('/objects/notes')) return stubRes(200, { id: '303', properties: {} });
        if (u.includes('/associations')) return stubRes(200, {});
      }
      return stubRes(404, { message: 'not stubbed' });
    };
    return { fetchImpl: impl, calls };
  }

  // Per-email cap via deliver function: use fresh jobId each time to avoid idempotency duplicate
  {
    deliverLimits._resetMemory();
    idem._resetMemory();
    jobs._resetMemory();
    process.env.DELIVER_PER_EMAIL_DAY = '2';
    process.env.PDF_EMAIL_DAILY_MAX = '1000';
    process.env.EMAIL_VERIFY = 'false';
    const stub = makeFetchStub();
    const origFetch = globalThis.fetch;
    globalThis.fetch = stub.fetchImpl;
    try {
      const createJob = async () => {
        const jid = jobs.newJobId();
        await jobs.put(jid, { status: 'done', blueprint, fields, email: 'cap-test@example.com', lead_id: null }, { env: process.env });
        return jid;
      };
      const j1 = await createJob();
      const r1 = await deliverFn({ httpMethod: 'POST', path: '/api/deliver', headers: { 'x-nf-client-connection-ip': '1.1.1.1' }, body: JSON.stringify({ token, jobId: j1, consent: true }) });
      ok(r1.statusCode === 200, 'per-email via deliver: 1st delivery ok (fresh job)');
      const j2 = await createJob();
      const r2 = await deliverFn({ httpMethod: 'POST', path: '/api/deliver', headers: { 'x-nf-client-connection-ip': '1.1.1.1' }, body: JSON.stringify({ token, jobId: j2, consent: true }) });
      ok(r2.statusCode === 200, 'per-email via deliver: 2nd delivery ok');
      const j3 = await createJob();
      const r3 = await deliverFn({ httpMethod: 'POST', path: '/api/deliver', headers: { 'x-nf-client-connection-ip': '1.1.1.1' }, body: JSON.stringify({ token, jobId: j3, consent: true }) });
      ok(r3.statusCode === 429, 'per-email via deliver: 3rd blocked with 429');
      ok(/Too many deliveries/.test(JSON.parse(r3.body).error), 'per-email blocked message clear');
    } finally {
      globalThis.fetch = origFetch;
      delete process.env.DELIVER_PER_EMAIL_DAY;
      delete process.env.PDF_EMAIL_DAILY_MAX;
      delete process.env.EMAIL_VERIFY;
      deliverLimits._resetMemory();
      idem._resetMemory();
      jobs._resetMemory();
    }
  }

  // Global cap via deliver function: past cap, deliver still returns PDF with email error, use fresh jobs
  {
    deliverLimits._resetMemory();
    idem._resetMemory();
    jobs._resetMemory();
    process.env.DELIVER_PER_EMAIL_DAY = '1000';
    process.env.PDF_EMAIL_DAILY_MAX = '1';
    process.env.PDF_EMAIL_API_KEY = 're_test_key';
    process.env.PDF_EMAIL_FROM = 'Test <test@example.com>';
    process.env.EMAIL_VERIFY = 'false';
    const stub = makeFetchStub();
    const origFetch = globalThis.fetch;
    globalThis.fetch = stub.fetchImpl;
    try {
      const createJob = async () => {
        const jid = jobs.newJobId();
        await jobs.put(jid, { status: 'done', blueprint, fields, email: 'cap-test@example.com', lead_id: null }, { env: process.env });
        return jid;
      };
      const j1 = await createJob();
      const r1 = await deliverFn({ httpMethod: 'POST', path: '/api/deliver', headers: { 'x-nf-client-connection-ip': '2.2.2.2' }, body: JSON.stringify({ token, jobId: j1, consent: true }) });
      const j1b = JSON.parse(r1.body);
      ok(r1.statusCode === 200 && j1b.email && j1b.email.sent === true, 'global via deliver: 1st email sent');

      const j2 = await createJob();
      const r2 = await deliverFn({ httpMethod: 'POST', path: '/api/deliver', headers: { 'x-nf-client-connection-ip': '2.2.2.2' }, body: JSON.stringify({ token, jobId: j2, consent: true }) });
      const j2b = JSON.parse(r2.body);
      ok(r2.statusCode === 200 && j2b.pdf_base64, 'global via deliver: 2nd still returns PDF past cap');
      ok(j2b.email && j2b.email.sent === false && j2b.email.error === 'daily email limit reached', 'global past cap: email:{sent:false,error:"daily email limit reached"}');
    } finally {
      globalThis.fetch = origFetch;
      delete process.env.DELIVER_PER_EMAIL_DAY;
      delete process.env.PDF_EMAIL_DAILY_MAX;
      delete process.env.PDF_EMAIL_API_KEY;
      delete process.env.PDF_EMAIL_FROM;
      delete process.env.EMAIL_VERIFY;
      deliverLimits._resetMemory();
      idem._resetMemory();
      jobs._resetMemory();
    }
  }

  // Server.js via harness for per-email cap (uses API to generate jobId)
  {
    deliverLimits._resetMemory();
    const srv = await startServer(8094, {
      DELIVER_PER_EMAIL_DAY: '1000',
      PDF_EMAIL_DAILY_MAX: '1000',
      PDF_EMAIL_API_KEY: 're_test_key',
      PDF_EMAIL_FROM: 'Test <test@example.com>',
      DEMO_MODE: 'true',
      EMAIL_VERIFY: 'false'
    });
    try {
      const login = await (await fetch(srv.base + '/api/auth/start', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: 'Server Cap', email: 'server-cap@example.com' }) })).json();
      const tok = login.token;
      const ex = await (await fetch(srv.base + '/api/extract', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ token: tok, answers }) })).json();
      const genRes = await (await fetch(srv.base + '/api/generate', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ token: tok, fields: ex.fields }) })).json();
      let jobDone = null;
      for (let i = 0; i < 50; i++) {
        const st = await (await fetch(srv.base + '/api/generate/status?jobId=' + encodeURIComponent(genRes.jobId) + '&token=' + encodeURIComponent(tok))).json();
        if (st.status === 'done') { jobDone = genRes.jobId; break; }
        await new Promise(r => setTimeout(r, 40));
      }
      ok(!!jobDone, 'server per-email: job completed');
      const r1 = await fetch(srv.base + '/api/deliver', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ token: tok, jobId: jobDone, consent: true }) });
      ok(r1.status === 200, 'server per-email: first delivery ok');
      const r2 = await fetch(srv.base + '/api/deliver', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ token: tok, jobId: jobDone, consent: true }) });
      const j2 = await r2.json();
      ok(r2.status === 200 && j2.duplicate === true, 'server per-email: duplicate returns duplicate:true');
    } finally {
      srv.stop();
      deliverLimits._resetMemory();
    }
  }

  console.log('\n' + (failures === 0 ? 'DEMO AND LIMITS TESTS PASSED' : failures + ' FAILURE(S)'));
  process.exit(failures === 0 ? 0 : 1);
})().catch(e => { console.error('Demo/limits test error:', e); process.exit(1); });
