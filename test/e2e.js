/* Quick end-to-end API test for the prototype (run: node test/e2e.js) */
const fs = require('fs');
const path = require('path');
const BASE = 'http://127.0.0.1:8080';

const PERSONAS = JSON.parse(fs.readFileSync(path.join(__dirname, 'personas.json'), 'utf8'));

async function post(p, body) {
  const r = await fetch(BASE + p, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  const j = await r.json().catch(() => ({}));
  return { code: r.status, j, r };
}
async function get(p) {
  const r = await fetch(BASE + p);
  return { code: r.status, r };
}

(async () => {
  let failures = 0;
  const ok = (cond, msg) => {
    console.log((cond ? '  PASS  ' : '  FAIL  ') + msg);
    if (!cond) failures++;
  };

  // 1. the entry gate: name + email, no password
  const lg = await post('/api/auth/start', { name: 'Allen Reyes', email: 'allen@pipelinesync.ai' });
  ok(lg.code === 200 && lg.j.token, 'the entry gate returns a token');
  ok(lg.j.user && lg.j.user.name === 'Allen Reyes', 'the token keeps the name the client typed');
  ok(lg.j.user && lg.j.user.first_name === 'Allen', 'the first name for the call greeting is derived');
  const T = lg.j.token;
  const lg2 = await post('/api/auth/start', { name: 'Allen Reyes', email: 'bad' });
  ok(lg2.code === 400, 'the entry gate rejects a bad email');
  const lg3 = await post('/api/auth/start', { name: '', email: 'allen@pipelinesync.ai' });
  ok(lg3.code === 400, 'the entry gate rejects a missing name');
  const lg4 = await post('/api/auth/start', { name: '<img src=x onerror=alert(1)>Al', email: 'allen@pipelinesync.ai' });
  ok(lg4.code === 200 && !/[<>]/.test(lg4.j.user.name) && !/script/i.test(lg4.j.user.name),
    'markup is stripped from the name (' + JSON.stringify(lg4.j.user && lg4.j.user.name) + ')');
  const lg5 = await post('/api/auth/login', { name: 'Allen Reyes', email: 'allen@pipelinesync.ai' });
  ok(lg5.code === 200 && lg5.j.token, 'the old /api/auth/login path still works as an alias');
  const lg6 = await post('/api/auth/start', { name: 'Allen Reyes', email: 'allen@pipelinesync.ai', password: 'ignored' });
  ok(lg6.code === 200, 'no password is required');

  for (const [key, persona] of Object.entries(PERSONAS)) {
    console.log('\n=== ' + persona.label + ' ===');
    const answers = Object.entries(persona.answers).map(([id, text]) => ({ id, text }));
    const ex = await post('/api/extract', { token: T, answers });
    const f = ex.j.fields;
    ok(ex.code === 200, 'extract returns 200');
    console.log('  fields:', JSON.stringify(f, null, 0).slice(0, 1200));

    const gen = await post('/api/generate', { token: T, fields: f });
    const bp = gen.j.blueprint;
    ok(gen.code === 200 && bp, 'generate returns blueprint');

    // QA assertions
    ok(bp.stack.tier.includes('Sales Hub Professional'), 'tier floor is Sales Hub Professional');
    ok(bp.coa.items.length === 3, 'exactly three cost-of-inaction estimates');
    ok(bp.kbReferences.length >= 5, 'KB references tagged (' + bp.kbReferences.length + ')');
    ok(bp.leadSources.length === f.lead_sources.length, 'all named lead sources present (' + bp.leadSources.length + ')');
    const blob = JSON.stringify(bp);
    ok(!blob.includes('\u2014'), 'no em dashes in blueprint JSON');
    if (key === 'solar') ok(JSON.stringify(bp.compliance).includes('TCPA'), 'solar: TCPA flag present');
    if (key === 'medical') ok(JSON.stringify(bp.compliance).includes('HIPAA'), 'medical: HIPAA flag present');
    if (key === 'home') ok(bp.pipeline.variant === 'two-call', 'home: two-call pipeline');
    if (key === 'medical') ok(bp.pipeline.variant === 'one-call', 'medical: one-call pipeline');

    const dv = await post('/api/deliver', { token: T, email: 'owner@' + key + '.ph', consent: true, fields: f, blueprint: bp });
    ok(dv.code === 200 && dv.j.contact_id, 'deliver returns hubspot contact id: ' + (dv.j.contact_id || ''));
    ok(!!dv.j.pdf_base64 && dv.j.filename.endsWith('.pdf'), 'deliver returns base64 pdf + filename');

    const buf = Buffer.from(dv.j.pdf_base64 || '', 'base64');
    const head = buf.slice(0, 8).toString('latin1');
    const tail = buf.slice(-6).toString('latin1');
    ok(head.startsWith('%PDF-1.4'), 'pdf has %PDF-1.4 header (' + buf.length + ' bytes)');
    ok(tail.trim() === '%%EOF', 'pdf ends with %%EOF');
    const text = Buffer.from(buf).toString('latin1');
    ok(text.includes('REVENUE OPERATIONS BLUEPRINT'), 'pdf contains title');
    ok(text.includes('Cost of inaction'), 'pdf contains cost of inaction section');
    if (key === 'solar') ok(text.includes('TCPA'), 'pdf contains TCPA flag');
    fs.writeFileSync(path.join(__dirname, 'sample_' + key + '.pdf'), Buffer.from(buf));

    // extract null-check: an answer-free run must return nulls
    const exNull = await post('/api/extract', { token: T, answers: answers.slice(0, 2) });
    const fn = exNull.j.fields;
    ok(fn.typical_deal_size === null && fn.close_rate === null, 'unstated numbers come back null');
  }

  // outbox
  const ob = await get('/dev/outbox');
  const obText = await ob.r.text();
  ok(ob.code === 200 && obText.includes('mock-hubspot'), 'dev outbox shows pushed leads');

  console.log('\n' + (failures === 0 ? 'ALL CHECKS PASSED' : failures + ' CHECK(S) FAILED'));
  process.exit(failures === 0 ? 0 : 1);
})().catch(e => { console.error('E2E error:', e); process.exit(1); });
