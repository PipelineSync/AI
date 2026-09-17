/* Simulates Netlify invoking the functions with Lambda-style events,
   so the deployed code path is tested before pushing to GitHub. */
const path = require('path');
const F = dir => require(path.join(__dirname, '..', 'netlify', 'functions', dir));
const login = F('login.js').handler;
const logout = F('logout.js').handler;
const extract = F('extract.js').handler;
const generate = F('generate.js').handler;
const deliver = F('deliver.js').handler;
const outbox = F('outbox.js').handler;
const voiceFn = F('voice.js').handler;
const health = F('health.js').handler;

const personas = require('./personas.json');
let failures = 0;
const ok = (cond, msg) => { console.log((cond ? '  PASS  ' : '  FAIL  ') + msg); if (!cond) failures++; };

(async () => {
  const h = await health({ httpMethod: 'GET', path: '/api/health' });
  ok(h.statusCode === 200 && JSON.parse(h.body).mode === 'netlify', 'health function (netlify mode)');

  const bad = await login({ httpMethod: 'POST', path: '/api/auth/login', body: JSON.stringify({ email: 'nope', password: 'x' }) });
  ok(bad.statusCode === 400, 'login rejects bad email');

  const lg = await login({ httpMethod: 'POST', path: '/api/auth/login', body: JSON.stringify({ email: 'allen@pipelinesync.ai', password: 'demo1234' }) });
  ok(lg.statusCode === 200 && JSON.parse(lg.body).token, 'login returns signed token');
  const T = JSON.parse(lg.body).token;

  // token must verify across "cold starts": require the core fresh
  delete require.cache[require.resolve('../lib/core')];
  const coreFresh = require('../lib/core');
  ok(!!coreFresh.verifyToken(T), 'token verifies in a fresh module instance (stateless auth)');

  const p = personas.solar;
  const answers = Object.entries(p.answers).map(([id, text]) => ({ id, text }));
  const ex = await extract({ httpMethod: 'POST', path: '/api/extract', body: JSON.stringify({ token: T, answers }) });
  ok(ex.statusCode === 200, 'extract function 200');
  const fields = JSON.parse(ex.body).fields;

  const gen = await generate({ httpMethod: 'POST', path: '/api/generate', body: JSON.stringify({ token: T, fields }) });
  ok(gen.statusCode === 200, 'generate function 200');
  const bp = JSON.parse(gen.body).blueprint;

  const dv = await deliver({ httpMethod: 'POST', path: '/api/deliver', body: JSON.stringify({ token: T, email: 'owner@solar.ph', consent: true, fields, blueprint: bp }) });
  ok(dv.statusCode === 200, 'deliver function 200');
  const dj = JSON.parse(dv.body);
  ok(!!dj.contact_id && !!dj.pdf_base64, 'deliver returns contact id + base64 pdf');
  const pdf = Buffer.from(dj.pdf_base64, 'base64');
  ok(pdf.slice(0, 8).toString('latin1').startsWith('%PDF-1.4'), 'function-generated pdf is valid');

  // base64-encoded body (Netlify may send binary bodies this way)
  const exB64 = await extract({ httpMethod: 'POST', path: '/api/extract', isBase64Encoded: true, body: Buffer.from(JSON.stringify({ token: T, answers })).toString('base64') });
  ok(exB64.statusCode === 200, 'extract handles base64-encoded body');

  // auth failures
  const noTok = await extract({ httpMethod: 'POST', path: '/api/extract', body: JSON.stringify({ answers }) });
  ok(noTok.statusCode === 401, 'extract rejects missing token');
  const badTok = await extract({ httpMethod: 'POST', path: '/api/extract', body: JSON.stringify({ token: 'garbage', answers }) });
  ok(badTok.statusCode === 401, 'extract rejects forged token');

  // voice layer through the Netlify function (same handler the dev server mounts)
  const vs = await voiceFn({ httpMethod: 'POST', path: '/api/voice/session', body: JSON.stringify({ token: T }) });
  ok(vs.statusCode === 200 && JSON.parse(vs.body).plan.length === 12, 'voice function serves the call plan through /api/voice/*');
  const vturn = await voiceFn({ httpMethod: 'POST', path: '/api/voice/turn', body: JSON.stringify({ token: T, call_id: 'sim-1', answers: [], asked: [], probes: {}, with_audio: false }) });
  const vj = JSON.parse(vturn.body);
  ok(vturn.statusCode === 200 && vj.ask.id === 'business', 'voice function serves a turn and the guardrail question');
  const vsub = await voiceFn({ httpMethod: 'POST', path: '/.netlify/functions/voice', queryStringParameters: { op: 'speak' }, body: JSON.stringify({ token: T, text: 'Testing.' }) });
  ok(vsub.statusCode === 200, 'voice function resolves its sub-route from the function path');
  const vno = await voiceFn({ httpMethod: 'POST', path: '/api/voice/turn', body: JSON.stringify({}) });
  ok(vno.statusCode === 401, 'voice function rejects a missing token');

  const ob = await outbox({ httpMethod: 'GET', path: '/dev/outbox' });
  ok(ob.statusCode === 200 && ob.body.includes('function logs'), 'outbox page explains where leads go on Netlify');

  const lo = await logout({ httpMethod: 'POST', path: '/api/auth/logout', body: JSON.stringify({ token: T }) });
  ok(lo.statusCode === 200, 'logout ok');

  console.log('\n' + (failures === 0 ? 'NETLIFY SIMULATION PASSED' : failures + ' FAILURES'));
  process.exit(failures === 0 ? 0 : 1);
})().catch(e => { console.error('Sim error:', e); process.exit(1); });
