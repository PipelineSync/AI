/*
 * Shared test harness: each test file gets its own dedicated instance of the app on a
 * dedicated port, started with the per-IP voice rate limit relaxed (VOICE_RATE_PER_MIN) and
 * the per-IP deliver limit relaxed the same way (DELIVER_RATE_PER_MIN; pass extraEnv to
 * startServer to put either back to its production default), with all OpenAI, HubSpot and
 * Resend credentials stripped. That makes `npm run test:all` repeatable:
 * a full suite run drives ~40 voice turns per minute from one IP, which would trip the
 * anti-runaway limiter (default 40/min per IP) if the tests shared the developer's
 * server. The production default in server.js is unchanged; the limiter still protects
 * the shared deploy. Stripping the credentials keeps tests hermetic: a key exported in
 * the shell can never make a test spend real OpenAI credit.
 */
const { spawn } = require('child_process');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const sleep = ms => new Promise(r => setTimeout(r, ms));

async function startServer(port, extraEnv) {
  // Start from the shell, then strip every credential a test must never really use, then apply
  // the explicit test values (extraEnv last, so a test can deliberately configure a server).
  const env = Object.assign({}, process.env);
  delete env.OPENAI_API_KEY;
  delete env.OPENAI_BASE_URL;
  delete env.HUBSPOT_ACCESS_TOKEN;
  delete env.HUBSPOT_API_KEY;
  delete env.HUBSPOT_TOKEN;
  // No Resend credentials either: a real PDF_EMAIL_API_KEY in the shell must never make a test
  // send a real email. Tests that exercise the send stub fetch itself.
  delete env.PDF_EMAIL_API_KEY;
  delete env.PDF_EMAIL_FROM;
  Object.assign(env, {
    PORT: String(port),
    VOICE_RATE_PER_MIN: '1000', // test-only: the suite drives more than 40 voice turns/minute from one IP
    // Phase 3: the same idea for /api/deliver (5 unlocks/minute/IP in production). A suite run
    // does several delivers from one IP; the test that exercises the limit asks for the
    // production default back through extraEnv.
    DELIVER_RATE_PER_MIN: '1000',
    PS_TOKEN_SECRET: 'test-secret',
  }, extraEnv || {});

  const child = spawn(process.execPath, [path.join(ROOT, 'server.js')], {
    cwd: ROOT,
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let logs = '';
  const onData = d => { logs += d; };
  child.stdout.on('data', onData);
  child.stderr.on('data', onData);
  let earlyExit = null;
  child.on('exit', (code, signal) => { earlyExit = 'exited ' + (code !== null ? code : signal); });

  const base = 'http://127.0.0.1:' + port;
  const deadline = Date.now() + 15000;
  while (Date.now() < deadline) {
    if (earlyExit) { throw new Error('test server on port ' + port + ' ' + earlyExit + ' at startup:\n' + logs); }
    try { const r = await fetch(base + '/api/health'); if (r.ok) break; } catch (e) {}
    await sleep(150);
  }
  let up = false;
  try { const r = await fetch(base + '/api/health'); up = r.ok; } catch (e) {}
  if (!up) {
    try { child.kill(); } catch (e) {}
    throw new Error('test server on port ' + port + ' did not become healthy:\n' + logs);
  }
  return { base, stop() { try { child.kill('SIGTERM'); } catch (e) {} } };
}

module.exports = { startServer };

/* Phase 2: /api/generate is asynchronous (202 + jobId, polled at
   /api/generate/status). generateBlueprint() drives the whole job over HTTP and
   returns the final status payload, so existing tests keep one call site. */
async function generateBlueprint(base, token, fields, opts) {
  opts = opts || {};
  const start = await fetch(base + '/api/generate', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ token, fields })
  });
  const sj = await start.json().catch(() => ({}));
  if (start.status !== 202 || !sj.jobId) return { code: start.status, j: sj, blueprint: null };
  const deadline = Date.now() + (opts.timeoutMs || 20000);
  while (Date.now() < deadline) {
    const r = await fetch(base + '/api/generate/status?jobId=' + encodeURIComponent(sj.jobId) + '&token=' + encodeURIComponent(token));
    const j = await r.json().catch(() => ({}));
    if (r.status === 200 && (j.status === 'done' || j.status === 'error')) {
      return { code: j.status === 'done' ? 200 : 500, j, blueprint: j.blueprint || null, jobId: sj.jobId };
    }
    await new Promise(res => setTimeout(res, 40));
  }
  throw new Error('generateBlueprint: timed out polling job ' + sj.jobId);
}

module.exports.generateBlueprint = generateBlueprint;
