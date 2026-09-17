/* Audits the running app against the developer brief's QA checklist (Section 9),
   covering the items the other suites do not assert:

     - every item in a blueprint resolves back to knowledge base v1: no invented
       property, stage, tool, feature, or price (the kbReferences are checked against
       the ids actually declared in the KB, not just counted)
     - confirmed defaults stay separate from custom items (section 6 of the blueprint)
     - the pipeline variant and its exact stages come from the KB, for all four verticals
     - every named lead source appears in the lead source architecture, by name, with a
       mechanism taken from the KB
     - exactly three cost-of-inaction estimates, each with a Basis line built from the
       client's own numbers
     - compliance flags per vertical (TCPA solar, HIPAA medical, none for the other two)
     - UK English and no dashes, in the blueprint and in the generated PDF
     - unstated numbers come back null, and the three required figures block generation
       on the API as well as in the browser (Section 9: the blueprint must be grounded in
       the client's own numbers)
     - the 12-question intake set (Section 6) covers all three required figures, and every
       field the extractor can produce has a label in the contract
     - no keys and no knowledge base text anywhere in public/

   Run: node test/brief-check.js */
const fs = require('fs');
const path = require('path');
const { startServer } = require('./harness');

const ROOT = path.join(__dirname, '..');
const core = require('../lib/core');
const voice = require('../lib/voice');
const personas = require('./personas.json');

/* The deployed path: invoke the Netlify function directly, the way netlify-sim does. */
const fnDir = dir => require(path.join(ROOT, 'netlify', 'functions', dir));

let failures = 0;
const ok = (cond, msg) => { console.log((cond ? '  PASS  ' : '  FAIL  ') + msg); if (!cond) failures++; };

const EXPECTED_VARIANT = { solar: 'two-call', medical: 'one-call', home_services: 'two-call', ecommerce: 'one-call' };
const EXPECTED_COMPLIANCE = { solar: ['TCPA'], medical: ['HIPAA'], home_services: [], ecommerce: [] };

/* US spellings that must not appear in client-facing output (the brief requires UK English).
   Word-bounded so the UK forms they resemble do not trip the check: "catalogue" is not
   "catalog", and "colour" is not "color". */
const US_SPELLINGS = [
  '\\borganiz', '\\banalyz', '\\brecogniz', '\\bbehavior', '\\bfavorite',
  '\\bcolors?\\b', '\\bcenters?\\b', '\\bdefense\\b', '\\bfulfills?\\b',
  '\\benrolls?\\b', '\\bcatalogs?\\b', '\\bapologize', '\\bprioritize'
];
const noUsSpelling = text => US_SPELLINGS.filter(w => new RegExp(w, 'i').test(text));

/* Only the words the PDF draws, not the file structure around them: "/Type /Catalog"
   is a PDF keyword, not copy the client reads. */
const pdfVisibleText = pdf => (pdf.match(/\((?:\\.|[^\\()])*\)/g) || []).map(s => s.slice(1, -1)).join(' ');

const kbMechanisms = core.KB.sourceMechanisms.map(m => m.text).concat([core.KB.sourceMechanismDefault.text]);

(async () => {
  const srv = await startServer(8098);
  process.on('exit', () => srv.stop());
  const post = async (p, body) => {
    const r = await fetch(srv.base + p, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    return { code: r.status, j: await r.json().catch(() => ({})) };
  };

  console.log('Knowledge base provenance (Section 9: no invented items)');
  const declaredIds = core.kbReferenceIds();
  ok(declaredIds.length >= 15, 'the knowledge base declares its reference ids (' + declaredIds.length + ' found)');
  ok(declaredIds.includes('KB-TIER-01') && declaredIds.includes('KB-PIPE-T2'),
    'the tier floor and the two-call pipeline are both declared ids');
  ok(declaredIds.includes('KB-PRISE-01') && declaredIds.includes('KB-BUILD-01'),
    'the pricing line and the build list are declared ids, not inline strings');
  ok(declaredIds.filter(i => i.startsWith('KB-TOOL-')).length === Object.keys(core.KB.tools).length,
    'every tool in the catalogue carries its own reference id (' + declaredIds.filter(i => i.startsWith('KB-TOOL-')).length + ')');

  const auth = await post('/api/auth/start', { name: 'Allen Reyes', email: 'allen@pipelinesync.ai' });
  const T = auth.j.token;

  for (const [key, persona] of Object.entries(personas)) {
    const label = persona.label;
    console.log('\n=== ' + label + ' (Section 9 checklist) ===');
    const answers = Object.entries(persona.answers).map(([id, text]) => ({ id, text }));
    const ex = await post('/api/extract', { token: T, answers });
    const f = ex.j.fields;
    const gen = await post('/api/generate', { token: T, fields: f });
    const bp = gen.j.blueprint;
    ok(gen.code === 200 && bp, 'the blueprint generates with the three required figures present');

    /* --- 1. nothing invented: every reference resolves to a declared KB id --- */
    const unknownRefs = bp.kbReferences.filter(id => !declaredIds.includes(id));
    ok(unknownRefs.length === 0,
      'every KB reference resolves to a declared knowledge base item' + (unknownRefs.length ? ' (unknown: ' + unknownRefs.join(', ') + ')' : ''));

    const badTools = bp.tools.filter(t => !core.KB.tools[t.name] || core.KB.tools[t.name].action !== t.action);
    ok(badTools.length === 0,
      'every tool action comes from the KB catalogue' + (badTools.length ? ' (offending: ' + badTools.map(t => t.name).join(', ') + ')' : ''));
    const reasonsOffKb = bp.tools.filter(t => {
      const kbReason = (core.KB.tools[t.name] || {}).reason || '';
      return kbReason && !t.reason.includes(kbReason.replace(/^You are on the entry tier\.\s*/, ''));
    });
    ok(reasonsOffKb.length === 0, 'every tool reason is the KB wording, unedited');
    const dupTier = bp.tools.filter(t => /You are on [^.]*\.\s*You are on the entry tier\./.test(t.reason));
    ok(dupTier.length === 0, 'the HubSpot reason does not repeat the tier sentence');

    const badStages = JSON.stringify(bp.pipeline.stages) !== JSON.stringify(core.KB.pipelines[bp.pipeline.variant].stages);
    ok(!badStages, 'the pipeline stages are exactly the KB stages for ' + bp.pipeline.variant);

    const badDefaults = bp.build.defaults.filter(d => !core.KB.defaults.includes(d));
    ok(badDefaults.length === 0, 'every confirmed default is a KB default');
    const badMech = bp.leadSources.filter(s => !kbMechanisms.includes(s.mechanism));
    ok(badMech.length === 0, 'every lead source mechanism is a KB mechanism');
    const priceOk = bp.stack.pricingLine.includes(String(core.KB.tiers.pricing.perSeatUSD)) &&
      bp.stack.pricingNote === core.KB.tiers.pricing.note;
    ok(priceOk, 'the only price quoted is the KB list price (' + core.KB.tiers.pricing.perSeatUSD + ' USD per seat)');

    /* --- 2. defaults separate from custom (section 6 of the blueprint) --- */
    ok(bp.build.defaults.length > 0 && bp.build.custom.length > 0,
      'section 6 holds both a defaults list (' + bp.build.defaults.length + ') and a custom list (' + bp.build.custom.length + ')');
    ok(bp.build.defaults.filter(d => bp.build.custom.includes(d)).length === 0,
      'no item appears in both the defaults and the custom list');

    /* --- 3. tier floor + pipeline variant --- */
    ok(bp.stack.tier.includes(core.KB.tiers.floor.name), 'the tier floor is ' + core.KB.tiers.floor.name);
    ok(bp.stack.rationale.some(r => r === core.KB.tiers.floor.rule), 'the tier floor carries its KB rule');
    ok(bp.pipeline.variant === EXPECTED_VARIANT[f.industry],
      label + ' gets the ' + EXPECTED_VARIANT[f.industry] + ' pipeline (' + bp.pipeline.stages.length + ' stages)');
    ok(bp.pipeline.variant === f.close_type, 'the variant follows the close type the client stated');

    /* --- 4. every named lead source appears, by name --- */
    const named = (f.lead_sources || []).map(s => s.source);
    const present = bp.leadSources.map(s => s.name);
    const missingSources = named.filter(n => !present.includes(n));
    ok(missingSources.length === 0,
      'every named lead source appears in the architecture' + (missingSources.length ? ' (missing: ' + missingSources.join(', ') + ')' : ' (' + named.length + ')'));
    ok(bp.leadSources.length === named.length, 'no lead source is invented or duplicated');

    /* --- 5. exactly three cost-of-inaction estimates, each with a Basis line --- */
    ok(bp.coa.items.length === 3, 'exactly three cost-of-inaction estimates');
    ok(bp.coa.items.every(c => c.basis && c.basis.length > 20), 'every estimate has a Basis line');
    const basis0 = bp.coa.items[0].basis;
    ok(basis0.includes(String(f.monthly_lead_volume)) && basis0.includes(core.fmtMoney(f.typical_deal_size).replace(/^PHP\s*/, '')),
      'the Basis line is built from the client numbers (' + f.monthly_lead_volume + ' leads, ' + core.fmtMoney(f.typical_deal_size) + ')');
    ok(!/null|undefined|NaN/.test(bp.coa.items.map(c => c.basis).join(' ')), 'no Basis line contains a null figure');

    /* --- 6. compliance flags --- */
    const want = EXPECTED_COMPLIANCE[f.industry];
    const got = bp.compliance.map(c => c.code);
    ok(JSON.stringify(got) === JSON.stringify(want),
      'compliance flags are ' + (want.length ? want.join('/') : 'none for this vertical') + ' (got: ' + (got.join('/') || 'none') + ')');

    /* --- 7. UK English, no dashes --- */
    const blob = JSON.stringify(bp);
    ok(!blob.includes('\u2014') && !blob.includes('\u2013'), 'no em or en dashes in the blueprint');
    const us = noUsSpelling(blob);
    ok(us.length === 0, 'UK English throughout the blueprint' + (us.length ? ' (found: ' + us.join(', ') + ')' : ''));

    /* --- 8. the PDF carries the same rules --- */
    const dv = await post('/api/deliver', { token: T, email: 'owner@' + key + '.ph', consent: true, fields: f, blueprint: bp });
    const pdf = Buffer.from(dv.j.pdf_base64 || '', 'base64').toString('latin1');
    const drawn = pdfVisibleText(pdf);
    ok(drawn.length > 500, 'the PDF carries readable text (' + drawn.length + ' characters)');
    ok((pdf.match(/Basis:/g) || []).length === 3, 'the PDF prints all three Basis lines');
    ok(!drawn.includes('\u2014') && !drawn.includes('\u2013'), 'no em or en dashes in the PDF');
    ok(noUsSpelling(drawn).length === 0, 'UK English in the PDF' + (noUsSpelling(drawn).length ? ' (found: ' + noUsSpelling(drawn).join(', ') + ')' : ''));
    ok(drawn.includes(core.KB.tiers.floor.name), 'the PDF states the tier floor');
  }

  /* --- unstated numbers: null, and generation is blocked on the API too --- */
  console.log('\n=== Required figures (Section 9) ===');
  const thin = await post('/api/extract', { token: T, answers: [{ id: 'business', text: 'We install solar panels for homeowners' }] });
  const tf = thin.j.fields;
  ok(core.REQUIRED_FIELDS.every(k => tf[k] === null), 'the three required figures come back null when unstated');
  const blocked = await post('/api/generate', { token: T, fields: tf });
  ok(blocked.code === 422, 'the API refuses to generate a blueprint on null figures (HTTP ' + blocked.code + ')');
  ok(JSON.stringify((blocked.j.missing_required || []).slice().sort()) === JSON.stringify(core.REQUIRED_FIELDS.slice().sort()),
    'the refusal names all three missing figures (' + (blocked.j.missing_required || []).join(', ') + ')');
  ok(/own numbers/.test(blocked.j.error || ''), 'the refusal explains why: ' + JSON.stringify(blocked.j.error));

  const part = Object.assign({}, tf, { typical_deal_size: 12000 });
  const partBlocked = await post('/api/generate', { token: T, fields: part });
  ok(partBlocked.code === 422 && partBlocked.j.missing_required.length === 2,
    'one figure filled in still blocks generation, naming the other two (' + (partBlocked.j.missing_required || []).join(', ') + ')');

  /* the deployed path enforces the same rule */
  const startFn = fnDir('start.js').handler;
  const generateFn = fnDir('generate.js').handler;
  const fnAuth = await startFn({ httpMethod: 'POST', path: '/api/auth/start', body: JSON.stringify({ name: 'Allen Reyes', email: 'allen@pipelinesync.ai' }) });
  const fnToken = JSON.parse(fnAuth.body).token;
  const fnBlocked = await generateFn({ httpMethod: 'POST', path: '/api/generate', body: JSON.stringify({ token: fnToken, fields: tf }) });
  ok(fnBlocked.statusCode === 422, 'the Netlify generate function refuses the same request (HTTP ' + fnBlocked.statusCode + ')');
  const fnOkRun = await generateFn({ httpMethod: 'POST', path: '/api/generate', body: JSON.stringify({ token: fnToken, fields: Object.assign({}, tf, { typical_deal_size: 12000, monthly_lead_volume: 40, close_rate: 20 }) }) });
  ok(fnOkRun.statusCode === 200 && JSON.parse(fnOkRun.body).blueprint, 'the Netlify function still generates once the figures are present');

  /* --- the intake set (Section 6) must be able to capture those figures --- */
  console.log('\n=== Intake set (Section 6) ===');
  ok(voice.INTAKE_PLAN.length === 12, 'the intake set is the 12-question guardrail set (' + voice.INTAKE_PLAN.length + ')');
  ok(new Set(voice.INTAKE_PLAN.map(q => q.id)).size === 12, 'every question has a distinct id');
  const covered = voice.INTAKE_PLAN.reduce((acc, q) => acc.concat(q.fields || []), []);
  const uncovered = core.REQUIRED_FIELDS.filter(k => !covered.includes(k));
  ok(uncovered.length === 0,
    'all three required figures are asked on the call' + (uncovered.length ? ' (never asked: ' + uncovered.join(', ') + ')' : ''));
  ok(JSON.stringify(voice.REQUIRED_FIELDS) === JSON.stringify(core.REQUIRED_FIELDS),
    'the voice layer and the API guard share one list of required figures');

  /* --- the contract has one label per field the extractor produces --- */
  const allKeys = new Set();
  Object.values(personas).forEach(p => {
    const f2 = core.extract(Object.entries(p.answers).map(([id, text]) => ({ id, text })));
    Object.keys(f2).forEach(k => allKeys.add(k));
  });
  const unlabelled = Array.from(allKeys).filter(k => !voice.FIELD_LABELS[k]);
  ok(unlabelled.length === 0,
    'every contract field the extractor produces has a label in the sidebar' + (unlabelled.length ? ' (unlabelled: ' + unlabelled.join(', ') + ')' : ' (' + allKeys.size + ' fields)'));

  /* --- nothing secret and no KB text ships to the browser --- */
  console.log('\n=== Browser payload ===');
  const shipped = ['index.html', 'app.js', 'styles.css', 'manifest.webmanifest']
    .map(n => fs.readFileSync(path.join(ROOT, 'public', n), 'utf8')).join('\n');
  ok(!/\bsk-(?:proj-)?[A-Za-z0-9_-]{16,}/.test(shipped), 'no API key material in public/');
  ok(!/PS_TOKEN_SECRET|SUPABASE_SERVICE_KEY|HUBSPOT_ACCESS_TOKEN/.test(shipped), 'no secret variable names in public/');
  const kbLeak = [core.KB.tiers.floor.rule, core.KB.pipelines['two-call'].note, core.KB.build.note]
    .filter(rule => shipped.includes(rule));
  ok(kbLeak.length === 0, 'the knowledge base text does not ship to the browser');
  ok(!shipped.includes('KB-TIER-01') && !shipped.includes('KB-PIPE-T2'), 'the KB reference ids do not ship to the browser');

  /* --- spoken figures: the call is voice, so answers arrive as words --- */
  console.log('\n=== Spoken figures (Section 7 contract) ===');
  const spoken = (id, text, field) => core.extract([{ id, text }])[field];
  const says = (id, text, field, want, label) => {
    const got = spoken(id, text, field);
    ok(got === want, label + ' -> ' + field + ' = ' + got + (got === want ? '' : ' (want ' + want + ')'));
  };
  says('deal', 'A typical deal is about one and a half million and three reps take calls', 'typical_deal_size', 1500000,
    'a spoken deal size is captured, and the clause after it is not swallowed');
  says('deal', 'A typical deal is about one and a half million and three reps take calls', 'sales_reps_on_calls', 3,
    'the rep count in the same sentence is still captured');
  says('deal', 'Most jobs are around eighty thousand each', 'typical_deal_size', 80000, 'a spoken deal size in words');
  says('deal', '\u20b180,000 per job', 'typical_deal_size', 80000, 'the peso symbol is recognised');
  says('volumes', 'About fifty five leads a month and we close 12', 'monthly_lead_volume', 55, 'a spoken lead volume');
  says('volumes', 'Roughly two hundred enquiries a month', 'monthly_lead_volume', 200, 'a spoken round lead volume');
  says('volumes', 'We close about twenty two percent', 'close_rate', 22, 'a spoken close rate');
  says('volumes', 'We close around thirty percent of them', 'close_rate', 30, 'a spoken round close rate');
  says('spend', 'we spend about fifty thousand a month on marketing and five thousand on software', 'monthly_marketing_spend', 50000,
    'the marketing figure nearest its own keyword, spoken');
  says('spend', 'we spend about fifty thousand a month on marketing and five thousand on software', 'monthly_software_budget', 5000,
    'the software figure is not read as the marketing spend');
  says('spend', 'on marketing we spend 50,000 a month', 'monthly_marketing_spend', 50000, 'the figure may follow the keyword');
  /* nothing invented: a stated count is not money, and silence is still null */
  says('volumes', 'We do two thousand installs a year', 'monthly_lead_volume', null, 'a count of installs is not read as money');
  says('volumes', 'Hard to say, we do not count them', 'monthly_lead_volume', null, 'an unstated volume stays null');
  says('deal', 'It varies a lot by job', 'typical_deal_size', null, 'an unstated deal size stays null');
  says('volumes', 'No idea what the rate is', 'close_rate', null, 'an unstated close rate stays null');
  /* the digit forms the personas use must not regress */
  says('deal', 'A typical deal is 1,500,000 pesos and three sales reps take calls', 'typical_deal_size', 1500000, 'digits still work');
  says('volumes', 'About 55 leads a month and we close 12', 'monthly_lead_volume', 55, 'digit volumes still work');
  says('volumes', 'We close 3 out of 10', 'close_rate', 30, 'the out-of form still works');
  says('spend', '80,000 on ads, about 15,000 on software', 'monthly_software_budget', 15000, 'digit budgets still work');

  srv.stop();
  console.log('\n' + (failures === 0 ? 'BRIEF CHECKS PASSED' : failures + ' CHECK(S) FAILED'));
  process.exit(failures === 0 ? 0 : 1);
})().catch(e => { console.error('BRIEF CHECK error:', e); process.exit(1); });
