/* Phase 2 — Claude-powered extract + generate.
 *
 * Covers: key-set path (stubbed Anthropic fetch returning valid JSON),
 * invalid JSON -> retry -> fallback, key-absent fallback, 429/5xx transport retry,
 * missing/invalid required fields -> 400 with field errors, the background job
 * lifecycle (202 + jobId -> status polling -> done), the removal of /api/ai/chat,
 * and PDF coverage of every blueprint field.
 */
const path = require('path');
const core = require('../lib/core');
const schema = require('../lib/blueprint-schema');
const anthropic = require('../lib/anthropic');
const aiPipeline = require('../lib/ai-pipeline');
const jobs = require('../lib/job-store');
const personas = require('./personas.json');

const F = f => require(path.join(__dirname, '..', 'netlify', 'functions', f));
const extractFn = F('extract.js').handler;
const generateFn = F('generate.js').handler;
const generateBgFn = F('generate-background.js').handler;
const statusFn = F('generate-status.js').handler;

let failures = 0;
const ok = (cond, msg) => { console.log((cond ? '  PASS  ' : '  FAIL  ') + msg); if (!cond) failures++; };
const section = t => console.log('\n' + t);

const ANSWERS = Object.entries(personas.solar.answers).map(([id, text]) => ({ id, text }));
const FIELDS = core.extract(ANSWERS);
const GOOD_BLUEPRINT = core.generate(FIELDS);
const TOKEN = core.signToken({ email: 'qa@pipelinesync.ai', name: 'QA Tester' });

/* An Anthropic stub: each entry in `plan` is one HTTP response. */
function anthropicStub(plan) {
  const calls = [];
  const queue = plan.slice();
  const fetchImpl = async (url, init) => {
    const body = JSON.parse(init.body);
    calls.push({ url: String(url), model: body.model, system: body.system, user: body.messages[0].content, headers: init.headers });
    const next = queue.length ? queue.shift() : plan[plan.length - 1];
    if (next.throw) throw new Error(next.throw);
    if (next.status && next.status >= 400) {
      return { ok: false, status: next.status, async text() { return JSON.stringify({ error: { message: 'boom' } }); } };
    }
    return {
      ok: true, status: 200,
      async json() { return { content: [{ type: 'text', text: next.text }], usage: { input_tokens: 10, output_tokens: 20 } }; }
    };
  };
  return { fetchImpl, calls };
}

const KEY_ENV = { ANTHROPIC_API_KEY: 'sk-ant-test-key-1234567890' };

/* Install env + a global fetch stub for the duration of fn(). Netlify functions read
   process.env and globalThis.fetch, exactly as they do on the deploy. */
async function withEnv(env, fetchImpl, fn) {
  const origFetch = globalThis.fetch;
  const saved = {};
  Object.keys(env).forEach(k => { saved[k] = process.env[k]; process.env[k] = env[k]; });
  if (fetchImpl) globalThis.fetch = fetchImpl;
  try { return await fn(); }
  finally {
    globalThis.fetch = origFetch;
    Object.keys(env).forEach(k => { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; });
  }
}

const post = (fn, body, extra) => fn(Object.assign({ httpMethod: 'POST', path: '/x', body: JSON.stringify(body) }, extra || {}));

/* Drive the async generate contract to completion. */
async function runGenerate(token, fields) {
  const res = await post(generateFn, { token, fields });
  const body = JSON.parse(res.body || '{}');
  if (res.statusCode !== 202) return { statusCode: res.statusCode, body, status: null };
  for (let i = 0; i < 200; i++) {
    const st = await statusFn({ httpMethod: 'GET', path: '/api/generate/status', queryStringParameters: { jobId: body.jobId, token } });
    const sj = JSON.parse(st.body || '{}');
    if (sj.status === 'done' || sj.status === 'error') return { statusCode: res.statusCode, body, status: sj, jobId: body.jobId };
    await new Promise(r => setTimeout(r, 10));
  }
  throw new Error('job never finished');
}

(async () => {
  /* ---------------------------------------------------------------- */
  section('model configuration (pinned default, one source of truth)');
  ok(/^claude-/.test(anthropic.DEFAULT_MODEL), 'a model id is pinned as the default (' + anthropic.DEFAULT_MODEL + ')');
  ok(anthropic.resolveModel({}) === anthropic.DEFAULT_MODEL, 'resolveModel falls back to the pinned default');
  ok(anthropic.resolveModel({ ANTHROPIC_MODEL: 'claude-custom-9' }) === 'claude-custom-9', 'ANTHROPIC_MODEL overrides the default');
  const fs = require('fs');
  const hardcoded = ['lib/ai-pipeline.js', 'lib/generate-job.js', 'netlify/functions/extract.js',
    'netlify/functions/generate.js', 'netlify/functions/generate-background.js', 'server.js']
    .filter(f => /claude-[a-z0-9.-]*\d/.test(fs.readFileSync(path.join(__dirname, '..', f), 'utf8')));
  ok(hardcoded.length === 0, 'no other file hardcodes a model id' + (hardcoded.length ? ' (found in ' + hardcoded.join(', ') + ')' : ''));

  /* ---------------------------------------------------------------- */
  section('schema validation');
  ok(schema.validateBlueprint(GOOD_BLUEPRINT).ok, 'the deterministic blueprint satisfies the schema');
  const broken = JSON.parse(JSON.stringify(GOOD_BLUEPRINT));
  delete broken.coa;
  broken.pipeline.variant = 'three-call';
  const bv = schema.validateBlueprint(broken);
  ok(!bv.ok && bv.errors.some(e => e.indexOf('coa') === 0) && bv.errors.some(e => /pipeline.variant/.test(e)),
    'a broken blueprint is rejected with per-field errors');
  ok(schema.validateExtractedFields(FIELDS).ok, 'the deterministic extraction satisfies the data contract');
  ok(!schema.validateExtractedFields({ industry: 'solar', nonsense: 1 }).ok, 'an off-contract extraction is rejected');

  section('server-side re-validation of the required review fields');
  const cases = [
    [{}, ['typical_deal_size', 'monthly_lead_volume', 'close_rate', 'close_type']],
    [{ typical_deal_size: 0, monthly_lead_volume: 55, close_rate: 22, close_type: 'one-call' }, ['typical_deal_size']],
    [{ typical_deal_size: 'abc', monthly_lead_volume: 55, close_rate: 22, close_type: 'one-call' }, ['typical_deal_size']],
    [{ typical_deal_size: 100, monthly_lead_volume: 55, close_rate: 180, close_type: 'one-call' }, ['close_rate']],
    [{ typical_deal_size: 100, monthly_lead_volume: 55, close_rate: 22, close_type: 'three-call' }, ['close_type']]
  ];
  cases.forEach(([f, keys]) => {
    const v = schema.validateGenerateFields(f);
    ok(!v.ok && keys.every(k => v.fieldErrors[k]), 'rejected: ' + JSON.stringify(f).slice(0, 60) + ' -> ' + keys.join(','));
  });
  ok(schema.validateGenerateFields(FIELDS).ok, 'the confirmed persona fields pass re-validation');

  /* ---------------------------------------------------------------- */
  section('extract: key absent -> deterministic fallback');
  const noKey = await withEnv({ ANTHROPIC_API_KEY: '' }, null,
    () => post(extractFn, { token: TOKEN, answers: ANSWERS }));
  const noKeyJson = JSON.parse(noKey.body);
  ok(noKey.statusCode === 200 && noKeyJson.source === 'fallback', 'no key: extract responds 200 with source=fallback');
  ok(noKeyJson.fields.typical_deal_size === FIELDS.typical_deal_size, 'no key: the deterministic fields are returned');

  section('extract: key set -> Claude path');
  const claudeFields = Object.assign({}, FIELDS, { biggest_headache: 'Claude wrote this one.' });
  const stubA = anthropicStub([{ text: JSON.stringify(claudeFields) }]);
  const exOk = await withEnv(KEY_ENV, stubA.fetchImpl, () => post(extractFn, { token: TOKEN, answers: ANSWERS }));
  const exOkJson = JSON.parse(exOk.body);
  ok(exOk.statusCode === 200 && exOkJson.source === 'claude', 'key set: extract reports source=claude');
  ok(exOkJson.fields.biggest_headache === 'Claude wrote this one.', "key set: Claude's fields are used");
  ok(stubA.calls.length === 1, 'key set: exactly one Anthropic call for valid output');
  ok(/Prompt B/.test(stubA.calls[0].system) || /extraction/i.test(stubA.calls[0].system), 'PROMPT_B is the system prompt for extract');
  ok(stubA.calls[0].headers['x-api-key'] === KEY_ENV.ANTHROPIC_API_KEY, 'the key travels in the server-side header only');

  section('extract: invalid JSON -> one retry -> fallback');
  const stubB = anthropicStub([{ text: 'Sure! Here is your data.' }, { text: '{"industry":"solar"}' }]);
  const exBad = await withEnv(KEY_ENV, stubB.fetchImpl, () => post(extractFn, { token: TOKEN, answers: ANSWERS }));
  const exBadJson = JSON.parse(exBad.body);
  ok(stubB.calls.length === 2, 'invalid output is retried exactly once (' + stubB.calls.length + ' calls)');
  ok(/rejected by server-side schema validation/.test(stubB.calls[1].user), 'the retry feeds the validation errors back to Claude');
  ok(exBad.statusCode === 200 && exBadJson.source === 'fallback', 'still invalid: extract falls back and says so');
  ok(exBadJson.fields.typical_deal_size === FIELDS.typical_deal_size, 'the fallback fields are the deterministic ones');

  section('extract: retry recovers on the second attempt');
  const stubC = anthropicStub([{ text: 'not json' }, { text: JSON.stringify(claudeFields) }]);
  const exRetry = await withEnv(KEY_ENV, stubC.fetchImpl, () => post(extractFn, { token: TOKEN, answers: ANSWERS }));
  ok(JSON.parse(exRetry.body).source === 'claude', 'a corrected second attempt is accepted as source=claude');

  section('extract: auth and input guards still apply');
  const exNoTok = await post(extractFn, { answers: ANSWERS });
  ok(exNoTok.statusCode === 401, 'extract without a token is 401');
  const exBadAns = await post(extractFn, { token: TOKEN, answers: [{ id: 'a', text: 'x'.repeat(5001) }] });
  ok(exBadAns.statusCode === 400, 'an over-long answer is 400');

  /* ---------------------------------------------------------------- */
  section('generate: missing / invalid required fields -> 400 with field errors');
  const bad400 = await post(generateFn, { token: TOKEN, fields: { monthly_lead_volume: 55 } });
  const bad400Json = JSON.parse(bad400.body);
  ok(bad400.statusCode === 400, 'generate returns a clean 400');
  ok(bad400Json.fieldErrors && bad400Json.fieldErrors.typical_deal_size && bad400Json.fieldErrors.close_rate && bad400Json.fieldErrors.close_type,
    'the 400 names every offending field');
  ok(!bad400Json.blueprint && !bad400Json.jobId, 'no job is created for invalid input');
  const bad400b = await post(generateFn, { token: TOKEN, fields: Object.assign({}, FIELDS, { close_rate: -5 }) });
  ok(bad400b.statusCode === 400 && JSON.parse(bad400b.body).fieldErrors.close_rate, 'a negative close rate is rejected');
  const genNoTok = await post(generateFn, { fields: FIELDS });
  ok(genNoTok.statusCode === 401, 'generate without a token is 401');

  section('generate: background job lifecycle');
  const lifecycle = await withEnv({ ANTHROPIC_API_KEY: '' }, null, () => runGenerate(TOKEN, FIELDS));
  ok(lifecycle.statusCode === 202 && lifecycle.body.jobId, 'generate returns 202 with a jobId');
  ok(lifecycle.body.pollUrl === '/api/generate/status?jobId=' + lifecycle.body.jobId, 'the 202 tells the client where to poll');
  ok(lifecycle.status.status === 'done' && lifecycle.status.blueprint, 'the status endpoint eventually reports done with the blueprint');
  ok(lifecycle.status.progress === 100 && lifecycle.status.step === 'done', 'a finished job reports real progress state, not a guess');
  ok(lifecycle.status.source === 'fallback', 'no key: the job records source=fallback');
  ok(schema.validateBlueprint(lifecycle.status.blueprint).ok, 'the delivered blueprint is schema-valid');

  section('generate status: guards');
  const stNoTok = await statusFn({ httpMethod: 'GET', queryStringParameters: { jobId: lifecycle.body.jobId } });
  ok(stNoTok.statusCode === 401, 'status without a token is 401');
  const stUnknown = await statusFn({ httpMethod: 'GET', queryStringParameters: { jobId: 'deadbeefdeadbeef', token: TOKEN } });
  ok(stUnknown.statusCode === 404, 'an unknown jobId is 404, never a fake success');
  const stGarbage = await statusFn({ httpMethod: 'GET', queryStringParameters: { jobId: '../../etc/passwd', token: TOKEN } });
  ok(stGarbage.statusCode === 404, 'a malformed jobId is rejected');

  section('generate: key set -> Claude blueprint through the job');
  const claudeBp = JSON.parse(JSON.stringify(GOOD_BLUEPRINT));
  claudeBp.summary.text = 'Claude wrote this summary. ' + claudeBp.summary.text;
  const stubD = anthropicStub([{ text: '```json\n' + JSON.stringify(claudeBp) + '\n```' }]);
  const genClaude = await withEnv(KEY_ENV, stubD.fetchImpl, () => runGenerate(TOKEN, FIELDS));
  ok(genClaude.status.status === 'done' && genClaude.status.source === 'claude', 'key set: the job reports source=claude');
  ok(/^Claude wrote this summary\./.test(genClaude.status.blueprint.summary.text), "Claude's blueprint is the one delivered");
  ok(/Prompt A/.test(stubD.calls[0].system) && /"meta"/.test(stubD.calls[0].system), 'PROMPT_A plus the schema is the system prompt for generate');
  ok(stubD.calls[0].model === anthropic.DEFAULT_MODEL, 'the pinned model is sent to the API');

  section('generate: invalid blueprint -> retry -> deterministic fallback');
  const malformed = JSON.parse(JSON.stringify(GOOD_BLUEPRINT));
  delete malformed.coa;
  malformed.stack.rationale = [];
  const stubE = anthropicStub([{ text: JSON.stringify(malformed) }, { text: JSON.stringify(malformed) }]);
  const genBad = await withEnv(KEY_ENV, stubE.fetchImpl, () => runGenerate(TOKEN, FIELDS));
  ok(stubE.calls.length === 2, 'an invalid blueprint is retried exactly once');
  ok(/rejected by server-side schema validation/.test(stubE.calls[1].user), 'the retry carries the blueprint validation errors');
  ok(genBad.status.status === 'done' && genBad.status.source === 'fallback', 'still invalid: the deterministic blueprint is used, reported as fallback');
  ok(schema.validateBlueprint(genBad.status.blueprint).ok, 'malformed output is never rendered: the delivered blueprint validates');

  section('generate: non-JSON prose is never rendered');
  const stubF = anthropicStub([{ text: 'I cannot produce that.' }, { text: 'Still no JSON.' }]);
  const genProse = await withEnv(KEY_ENV, stubF.fetchImpl, () => runGenerate(TOKEN, FIELDS));
  ok(genProse.status.source === 'fallback' && schema.validateBlueprint(genProse.status.blueprint).ok, 'prose output falls back to a valid blueprint');

  /* ---------------------------------------------------------------- */
  section('transport: one retry with backoff on 429 / 5xx');
  for (const status of [429, 500, 529]) {
    const stub = anthropicStub([{ status }, { text: JSON.stringify(GOOD_BLUEPRINT) }]);
    const t0 = Date.now();
    const res = await aiPipeline.runGenerate(FIELDS, { env: KEY_ENV, fetchImpl: stub.fetchImpl, backoffMs: 30 });
    ok(stub.calls.length === 2 && res.source === 'claude', 'HTTP ' + status + ' is retried once and then succeeds');
    ok(Date.now() - t0 >= 30, 'HTTP ' + status + ' retry waits for the backoff');
  }
  const stubDown = anthropicStub([{ status: 503 }, { status: 503 }]);
  const resDown = await aiPipeline.runGenerate(FIELDS, { env: KEY_ENV, fetchImpl: stubDown.fetchImpl, backoffMs: 5 });
  ok(resDown.source === 'fallback' && resDown.aiError, 'a persistent outage falls back rather than failing the journey');
  const stubNet = anthropicStub([{ throw: 'socket hang up' }, { text: JSON.stringify(GOOD_BLUEPRINT) }]);
  const resNet = await aiPipeline.runGenerate(FIELDS, { env: KEY_ENV, fetchImpl: stubNet.fetchImpl, backoffMs: 5 });
  ok(resNet.source === 'claude', 'a network error is retried once');

  section('the background function is a worker, not an open endpoint');
  const bgNoTok = await post(generateBgFn, { jobId: 'a'.repeat(32), fields: FIELDS });
  ok(bgNoTok.statusCode === 401, 'generate-background rejects a missing token');
  const bgBadJob = await post(generateBgFn, { token: TOKEN, jobId: 'nope', fields: FIELDS });
  ok(bgBadJob.statusCode === 400, 'generate-background rejects a malformed jobId');
  const bgJobId = jobs.newJobId();
  const bgBadFields = await post(generateBgFn, { token: TOKEN, jobId: bgJobId, fields: { close_rate: 22 } });
  ok(bgBadFields.statusCode === 400, 'generate-background re-validates the fields itself');
  const bgRec = await jobs.get(bgJobId);
  ok(bgRec && bgRec.status === 'error' && bgRec.fieldErrors, 'the failure is recorded on the job so the client learns about it');
  const bgOkId = jobs.newJobId();
  await withEnv({ ANTHROPIC_API_KEY: '' }, null, () => post(generateBgFn, { token: TOKEN, jobId: bgOkId, fields: FIELDS }));
  const bgOkRec = await jobs.get(bgOkId);
  ok(bgOkRec && bgOkRec.status === 'done' && schema.validateBlueprint(bgOkRec.blueprint).ok, 'the worker stores a schema-valid blueprint');

  /* ---------------------------------------------------------------- */
  section('/api/ai arbitrary-prompt passthrough is gone');
  let aiExists = true;
  try { require.resolve(path.join(__dirname, '..', 'netlify', 'functions', 'ai.js')); } catch (e) { aiExists = false; }
  ok(!aiExists, 'netlify/functions/ai.js is deleted');
  const toml = fs.readFileSync(path.join(__dirname, '..', 'netlify.toml'), 'utf8');
  ok(!/\/api\/ai/.test(toml), 'the /api/ai/* redirect is removed from netlify.toml');
  ok(/\/api\/generate\/status/.test(toml), 'the status endpoint is routed in netlify.toml');
  ok(/\[functions\][\s\S]*timeout\s*=/.test(toml), 'a functions timeout is configured');
  const serverSrc = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
  ok(!/system_prompt/.test(serverSrc), 'server.js no longer accepts a client-supplied system prompt');
  ok(!fs.readFileSync(path.join(__dirname, '..', 'public', 'app.js'), 'utf8').match(/\/api\/ai\//), 'the client never calls /api/ai/');

  /* ---------------------------------------------------------------- */
  section('PDF renders every blueprint field, wrapped and paginated');
  const longFields = JSON.parse(JSON.stringify(FIELDS));
  longFields.business_description = 'We install residential and commercial solar systems. ' + 'This sentence exists to force the writer to wrap and paginate a very long paragraph of prose. '.repeat(30);
  longFields.six_month_goal = 'Reach 20 closed installs a month while ' + 'expanding into three new provinces and keeping the crew utilisation above ninety percent. '.repeat(20);
  const longBp = core.generate(longFields);
  const pdf = core.buildPdf(longBp);
  const pdfText = pdf.toString('latin1');
  ok(pdf.slice(0, 8).toString('latin1').startsWith('%PDF-1.4'), 'the long blueprint still produces a valid PDF');
  const pageCount = (pdfText.match(/\/Type \/Page[^s]/g) || []).length;
  ok(pageCount >= 2, 'long text paginates across ' + pageCount + ' pages');
  ok(/Page 1 of /.test(pdfText) && pdfText.indexOf('Page ' + pageCount + ' of ' + pageCount) > 0, 'every page is numbered');
  // Re-assemble the rendered text: unescape the PDF strings and collapse the wrap
  // points, so a field counts as present even when it wrapped across lines.
  const rendered = (pdfText.match(/\((?:\\.|[^()\\])*\)\s*Tj/g) || [])
    .map(t => t.replace(/\)\s*Tj$/, '').replace(/^\(/, '').replace(/\\([()\\])/g, '$1'))
    .join(' ').replace(/\s+/g, ' ');
  const norm = t => String(t).replace(/\s+/g, ' ').trim();
  const mustAppear = [
    longBp.meta.verticalLabel, longBp.meta.date, longBp.meta.generatedBy,
    longBp.summary.stats[0].label, longBp.stack.tier, longBp.stack.pricingLine.slice(0, 20),
    longBp.pipeline.label, longBp.pipeline.stages[0], longBp.pipeline.workflows[0].slice(0, 20),
    longBp.leadSources[0].name, longBp.tools[0].name, longBp.build.defaults[0].slice(0, 20),
    longBp.build.custom[0].slice(0, 20), longBp.coa.items[0].title.slice(0, 20),
    longBp.compliance.length ? longBp.compliance[0].code : 'Compliance',
    longBp.nextSteps[0].slice(0, 20), longBp.kbReferences[0]
  ];
  const missing = mustAppear.filter(t => rendered.indexOf(norm(t)) < 0);
  ok(missing.length === 0, 'every blueprint field reaches the PDF' + (missing.length ? ' (missing: ' + missing.join(' | ') + ')' : ''));
  const longest = pdfText.split('\n').filter(l => /Tj$/.test(l)).map(l => l.length).sort((a, b) => b - a)[0];
  ok(longest < 400, 'no unwrapped monster line in the content stream (longest ' + longest + ' chars)');

  console.log('\n' + (failures === 0 ? 'CLAUDE PIPELINE TESTS PASSED' : failures + ' CLAUDE PIPELINE FAILURES'));
  process.exit(failures === 0 ? 0 : 1);
})().catch(e => { console.error('Test error:', e); process.exit(1); });
