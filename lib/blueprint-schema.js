'use strict';
/*
 * Blueprint schema — the single server-side contract for anything we render.
 *
 * Used by:
 *   - lib/ai-pipeline.js   (validates Claude JSON before it is ever rendered)
 *   - netlify/functions/*  (validates the review fields before calling Claude)
 *
 * Nothing malformed reaches the PDF writer or the browser: validateBlueprint()
 * returns a flat list of human-readable errors that we can feed straight back to
 * Claude on the retry pass.
 */

/* The required review fields, re-validated server-side before any AI call. */
const REQUIRED_FIELDS = [
  { key: 'typical_deal_size', label: 'Typical deal size', type: 'positive-number' },
  { key: 'monthly_lead_volume', label: 'Monthly lead volume', type: 'positive-number' },
  { key: 'close_rate', label: 'Close rate', type: 'percent' },
  { key: 'close_type', label: 'Close type', type: 'enum', values: ['one-call', 'two-call'] }
];

function toNumber(v) {
  if (v == null || v === '') return null;
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  const n = parseFloat(String(v).replace(/[, ]/g, ''));
  return Number.isFinite(n) ? n : null;
}

/**
 * Re-validate the confirmed review fields server-side (never trust the client).
 * @returns {{ok: boolean, fieldErrors: Object<string,string>, values: Object}}
 */
function validateGenerateFields(fields) {
  const fieldErrors = {};
  const values = {};
  const f = fields && typeof fields === 'object' ? fields : {};
  for (const spec of REQUIRED_FIELDS) {
    const raw = f[spec.key];
    if (spec.type === 'enum') {
      const v = raw == null ? '' : String(raw).trim().toLowerCase();
      if (!v) fieldErrors[spec.key] = spec.label + ' is required.';
      else if (spec.values.indexOf(v) < 0) fieldErrors[spec.key] = spec.label + ' must be one of: ' + spec.values.join(', ') + '.';
      else values[spec.key] = v;
      continue;
    }
    const n = toNumber(raw);
    if (raw == null || raw === '') { fieldErrors[spec.key] = spec.label + ' is required.'; continue; }
    if (n == null) { fieldErrors[spec.key] = spec.label + ' must be a number.'; continue; }
    if (!(n > 0)) { fieldErrors[spec.key] = spec.label + ' must be greater than zero.'; continue; }
    if (spec.type === 'percent' && n > 100) { fieldErrors[spec.key] = spec.label + ' must be between 1 and 100.'; continue; }
    values[spec.key] = n;
  }
  return { ok: Object.keys(fieldErrors).length === 0, fieldErrors, values };
}

/* ------------------------------------------------------------------ */
/* Blueprint document validation                                       */
/* ------------------------------------------------------------------ */

const isStr = v => typeof v === 'string' && v.trim().length > 0;
const isArr = v => Array.isArray(v);
const isNum = v => typeof v === 'number' && Number.isFinite(v);

function checkObj(errors, obj, path, keys) {
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) {
    errors.push(path + ': must be an object');
    return false;
  }
  for (const k of keys) if (!(k in obj)) errors.push(path + '.' + k + ': missing');
  return true;
}

/**
 * Validate a blueprint document against the schema the PDF writer expects.
 * @returns {{ok: boolean, errors: string[]}}
 */
function validateBlueprint(bp) {
  const errors = [];
  if (!bp || typeof bp !== 'object' || Array.isArray(bp)) {
    return { ok: false, errors: ['blueprint: must be a JSON object'] };
  }

  if (checkObj(errors, bp.meta, 'meta', ['businessLine', 'vertical', 'verticalLabel', 'date', 'generatedBy'])) {
    ['businessLine', 'vertical', 'verticalLabel', 'date', 'generatedBy'].forEach(k => {
      if (k in bp.meta && !isStr(bp.meta[k])) errors.push('meta.' + k + ': must be a non-empty string');
    });
  }

  if (checkObj(errors, bp.summary, 'summary', ['text', 'stats'])) {
    if ('text' in bp.summary && !isStr(bp.summary.text)) errors.push('summary.text: must be a non-empty string');
    if (!isArr(bp.summary.stats)) errors.push('summary.stats: must be an array');
    else bp.summary.stats.forEach((s, i) => {
      if (!s || typeof s !== 'object') errors.push('summary.stats[' + i + ']: must be an object');
      else {
        if (!isStr(s.label)) errors.push('summary.stats[' + i + '].label: must be a non-empty string');
        if (!isStr(s.value) && !isNum(s.value)) errors.push('summary.stats[' + i + '].value: must be a string or number');
      }
    });
  }

  if (checkObj(errors, bp.stack, 'stack', ['tier', 'enterprise', 'addOns', 'pricingLine', 'pricingNote', 'rationale'])) {
    if (!isStr(bp.stack.tier)) errors.push('stack.tier: must be a non-empty string');
    if (typeof bp.stack.enterprise !== 'boolean') errors.push('stack.enterprise: must be a boolean');
    if (!isArr(bp.stack.addOns)) errors.push('stack.addOns: must be an array of strings');
    else if (bp.stack.addOns.some(a => !isStr(a))) errors.push('stack.addOns: every entry must be a non-empty string');
    if (!isStr(bp.stack.pricingLine)) errors.push('stack.pricingLine: must be a non-empty string');
    if (!isStr(bp.stack.pricingNote)) errors.push('stack.pricingNote: must be a non-empty string');
    if (!isArr(bp.stack.rationale) || !bp.stack.rationale.length) errors.push('stack.rationale: must be a non-empty array of strings');
    else if (bp.stack.rationale.some(r => !isStr(r))) errors.push('stack.rationale: every entry must be a non-empty string');
  }

  if (checkObj(errors, bp.pipeline, 'pipeline', ['variant', 'label', 'stages', 'note', 'workflows'])) {
    if (['one-call', 'two-call'].indexOf(bp.pipeline.variant) < 0) errors.push('pipeline.variant: must be "one-call" or "two-call"');
    if (!isStr(bp.pipeline.label)) errors.push('pipeline.label: must be a non-empty string');
    if (!isArr(bp.pipeline.stages) || bp.pipeline.stages.length < 2) errors.push('pipeline.stages: must be an array of at least 2 stage names');
    else if (bp.pipeline.stages.some(s => !isStr(s))) errors.push('pipeline.stages: every stage must be a non-empty string');
    if (!isStr(bp.pipeline.note)) errors.push('pipeline.note: must be a non-empty string');
    if (!isArr(bp.pipeline.workflows)) errors.push('pipeline.workflows: must be an array of strings');
    else if (bp.pipeline.workflows.some(w => !isStr(w))) errors.push('pipeline.workflows: every entry must be a non-empty string');
  }

  if (!isArr(bp.leadSources)) errors.push('leadSources: must be an array (may be empty)');
  else bp.leadSources.forEach((s, i) => {
    const p = 'leadSources[' + i + ']';
    if (!s || typeof s !== 'object') { errors.push(p + ': must be an object'); return; }
    if (!isStr(s.name)) errors.push(p + '.name: must be a non-empty string');
    if (!(s.monthlyVolume === null || isNum(s.monthlyVolume))) errors.push(p + '.monthlyVolume: must be a number or null');
    if (!(s.tracked === true || s.tracked === false || s.tracked === null)) errors.push(p + '.tracked: must be true, false or null');
    if (!isStr(s.mechanism)) errors.push(p + '.mechanism: must be a non-empty string');
  });

  if (!isArr(bp.tools)) errors.push('tools: must be an array (may be empty)');
  else bp.tools.forEach((t, i) => {
    const p = 'tools[' + i + ']';
    if (!t || typeof t !== 'object') { errors.push(p + ': must be an object'); return; }
    if (!isStr(t.name)) errors.push(p + '.name: must be a non-empty string');
    if (!isStr(t.action)) errors.push(p + '.action: must be a non-empty string');
    if (!isStr(t.reason)) errors.push(p + '.reason: must be a non-empty string');
  });

  if (checkObj(errors, bp.build, 'build', ['defaults', 'custom'])) {
    ['defaults', 'custom'].forEach(k => {
      if (!isArr(bp.build[k]) || !bp.build[k].length) errors.push('build.' + k + ': must be a non-empty array of strings');
      else if (bp.build[k].some(x => !isStr(x))) errors.push('build.' + k + ': every entry must be a non-empty string');
    });
  }

  if (checkObj(errors, bp.coa, 'coa', ['items', 'totalMonthly', 'totalSix'])) {
    if (!isArr(bp.coa.items) || !bp.coa.items.length) errors.push('coa.items: must be a non-empty array');
    else bp.coa.items.forEach((c, i) => {
      const p = 'coa.items[' + i + ']';
      if (!c || typeof c !== 'object') { errors.push(p + ': must be an object'); return; }
      if (!isStr(c.title)) errors.push(p + '.title: must be a non-empty string');
      if (!isNum(c.value)) errors.push(p + '.value: must be a number (PHP, no formatting)');
      if (!isStr(c.period)) errors.push(p + '.period: must be a non-empty string, e.g. "per month"');
      if (!isStr(c.basis)) errors.push(p + '.basis: must be a non-empty string explaining the calculation');
    });
    if (!isNum(bp.coa.totalMonthly)) errors.push('coa.totalMonthly: must be a number');
    if (!isNum(bp.coa.totalSix)) errors.push('coa.totalSix: must be a number');
  }

  if (!isArr(bp.compliance)) errors.push('compliance: must be an array (may be empty)');
  else bp.compliance.forEach((c, i) => {
    const p = 'compliance[' + i + ']';
    if (!c || typeof c !== 'object') { errors.push(p + ': must be an object'); return; }
    if (!isStr(c.code)) errors.push(p + '.code: must be a non-empty string');
    if (!isStr(c.note)) errors.push(p + '.note: must be a non-empty string');
  });

  if (!isArr(bp.nextSteps) || !bp.nextSteps.length) errors.push('nextSteps: must be a non-empty array of strings');
  else if (bp.nextSteps.some(s => !isStr(s))) errors.push('nextSteps: every entry must be a non-empty string');

  if (!isArr(bp.kbReferences) || !bp.kbReferences.length) errors.push('kbReferences: must be a non-empty array of KB ids');
  else if (bp.kbReferences.some(s => !isStr(s))) errors.push('kbReferences: every entry must be a non-empty string');

  return { ok: errors.length === 0, errors };
}

/* The schema, described for the model. Appended to PROMPT_A so Claude returns
   exactly what validateBlueprint() accepts and the PDF writer can render. */
const BLUEPRINT_SCHEMA_TEXT = `
Return ONLY a JSON object (no prose, no markdown fences) with exactly this shape:

{
  "meta": { "businessLine": string, "vertical": string, "verticalLabel": string, "date": string, "generatedBy": "PipelineSync AI (Claude, Prompt A) + knowledge base v1" },
  "summary": { "text": string, "stats": [ { "label": string, "value": string } ] },
  "stack": { "tier": string, "enterprise": boolean, "addOns": string[], "pricingLine": string, "pricingNote": string, "rationale": string[] },
  "pipeline": { "variant": "one-call" | "two-call", "label": string, "stages": string[], "note": string, "workflows": string[] },
  "leadSources": [ { "name": string, "monthlyVolume": number|null, "tracked": true|false|null, "mechanism": string } ],
  "tools": [ { "name": string, "action": string, "reason": string } ],
  "build": { "defaults": string[], "custom": string[] },
  "coa": { "items": [ { "title": string, "value": number, "period": string, "basis": string } ], "totalMonthly": number, "totalSix": number },
  "compliance": [ { "code": string, "note": string } ],
  "nextSteps": string[],
  "kbReferences": string[]
}

All monetary values inside coa are plain numbers in PHP with no currency symbol, separators or units.
Every array listed as non-empty above must contain at least one entry: stack.rationale, build.defaults, build.custom, coa.items, nextSteps, kbReferences.
`.trim();

/* Extraction output (Section 7 data contract) — the 23 fields. */
const CONTRACT_FIELDS = [
  'industry', 'business_description', 'products', 'typical_deal_size', 'sales_reps_on_calls',
  'fulfilment_headcount', 'fulfilment_method', 'marketing_ops_owner', 'close_type',
  'sales_process_notes', 'lead_sources', 'lead_capture_method', 'current_crm',
  'current_hubspot_tier', 'current_tools', 'monthly_lead_volume', 'monthly_deal_volume',
  'close_rate', 'sales_cycle_length', 'biggest_headache', 'six_month_goal',
  'monthly_marketing_spend', 'monthly_software_budget'
];

/**
 * Validate Claude's extraction output against the Section 7 data contract.
 * Values may be null (unstated), but the shape must be right.
 * @returns {{ok: boolean, errors: string[]}}
 */
function validateExtractedFields(fields) {
  const errors = [];
  if (!fields || typeof fields !== 'object' || Array.isArray(fields)) {
    return { ok: false, errors: ['fields: must be a JSON object'] };
  }
  for (const k of CONTRACT_FIELDS) if (!(k in fields)) errors.push(k + ': missing (use null when the client did not state it)');
  const extra = Object.keys(fields).filter(k => CONTRACT_FIELDS.indexOf(k) < 0);
  if (extra.length) errors.push('unexpected fields (not in the data contract): ' + extra.join(', '));

  ['products', 'lead_sources', 'current_tools'].forEach(k => {
    if (k in fields && fields[k] != null && !Array.isArray(fields[k])) errors.push(k + ': must be an array or null');
  });
  ['typical_deal_size', 'monthly_lead_volume', 'monthly_deal_volume', 'close_rate',
    'sales_reps_on_calls', 'fulfilment_headcount', 'monthly_marketing_spend', 'monthly_software_budget'
  ].forEach(k => {
    if (k in fields && fields[k] != null && !isNum(fields[k])) errors.push(k + ': must be a number or null');
  });
  if (fields.close_type != null && ['one-call', 'two-call'].indexOf(fields.close_type) < 0) {
    errors.push('close_type: must be "one-call", "two-call" or null');
  }
  if (Array.isArray(fields.lead_sources)) {
    fields.lead_sources.forEach((s, i) => {
      if (!s || typeof s !== 'object') { errors.push('lead_sources[' + i + ']: must be an object'); return; }
      if (!isStr(s.source)) errors.push('lead_sources[' + i + '].source: must be a non-empty string');
      if (!(s.monthly_volume === null || s.monthly_volume === undefined || isNum(s.monthly_volume))) errors.push('lead_sources[' + i + '].monthly_volume: must be a number or null');
      if (!(s.tracked === true || s.tracked === false || s.tracked === null || s.tracked === undefined)) errors.push('lead_sources[' + i + '].tracked: must be true, false or null');
    });
  }
  return { ok: errors.length === 0, errors };
}

const CONTRACT_SCHEMA_TEXT = `
Return ONLY a JSON object (no prose, no markdown fences) with EXACTLY these 23 keys and no others:
${CONTRACT_FIELDS.join(', ')}.

Numeric fields (typical_deal_size, monthly_lead_volume, monthly_deal_volume, close_rate, sales_reps_on_calls, fulfilment_headcount, monthly_marketing_spend, monthly_software_budget) must be plain numbers or null — never strings, never formatted.
products, lead_sources and current_tools are arrays (use [] when nothing was stated).
lead_sources entries are { "source": string, "monthly_volume": number|null, "tracked": true|false|null }.
close_type is "one-call", "two-call" or null. Anything the client did not state stays null.
`.trim();

module.exports = {
  REQUIRED_FIELDS, CONTRACT_FIELDS,
  validateGenerateFields, validateBlueprint, validateExtractedFields,
  BLUEPRINT_SCHEMA_TEXT, CONTRACT_SCHEMA_TEXT
};
