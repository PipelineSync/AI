'use strict';
/*
 * Shared Claude pipeline for extract (PROMPT_B) and generate (PROMPT_A).
 *
 * One implementation, used by server.js and the Netlify functions, so the local
 * and deployed journeys cannot drift apart.
 *
 * Guarantees:
 *  - Claude output is parsed AND validated against the schema (lib/blueprint-schema.js)
 *    before anything is rendered.
 *  - Invalid output -> ONE retry with the validation errors fed back -> deterministic
 *    fallback if it is still invalid. Malformed output is never returned.
 *  - Transport failures on 429/5xx -> ONE retry with a short backoff.
 *  - The caller always learns which path produced the result: source "claude" | "fallback".
 */

const core = require('./core');
const anthropic = require('./anthropic');
const schema = require('./blueprint-schema');

const RETRY_BACKOFF_MS = 600;

const wait = ms => new Promise(r => setTimeout(r, ms));

/**
 * Call Claude for JSON, retrying once on 429/5xx / network errors with a short backoff.
 */
async function callWithTransportRetry(opts) {
  const backoffMs = opts.backoffMs != null ? opts.backoffMs : RETRY_BACKOFF_MS;
  let result = await anthropic.callClaudeJSON(opts);
  if (!result.ok && result.retryable) {
    await wait(backoffMs);
    result = await anthropic.callClaudeJSON(opts);
  }
  return result;
}

/**
 * Generic "ask Claude for validated JSON" loop: at most two attempts, the second
 * one carrying the validation errors from the first.
 *
 * @param {Object} o
 * @param {string} o.systemPrompt
 * @param {string} o.userMessage
 * @param {Function} o.validate  - (data) => {ok, errors}
 * @param {Object} [o.env]
 * @param {Function} [o.fetchImpl]
 * @param {number} [o.backoffMs]
 * @returns {Promise<{ok: boolean, data?: Object, attempts: number, errors: string[], error?: string}>}
 */
async function claudeValidatedJSON(o) {
  const env = o.env || process.env;
  const base = {
    systemPrompt: o.systemPrompt,
    model: anthropic.resolveModel(env),
    env,
    fetchImpl: o.fetchImpl || globalThis.fetch,
    backoffMs: o.backoffMs
  };

  let lastErrors = [];
  let transportError = null;
  let attempts = 0;
  let userMessage = o.userMessage;

  for (let attempt = 1; attempt <= 2; attempt++) {
    attempts = attempt;
    const res = await callWithTransportRetry(Object.assign({}, base, { userMessage }));
    if (!res.ok) { transportError = res.error; break; }

    if (!res.data || typeof res.data !== 'object') {
      lastErrors = ['response: was not valid JSON. ' + (res.parseError || 'Return only a JSON object.')];
    } else {
      const v = o.validate(res.data);
      if (v.ok) return { ok: true, data: res.data, attempts, errors: [] };
      lastErrors = v.errors;
    }

    if (attempt === 1) {
      userMessage = o.userMessage +
        '\n\nYour previous response was rejected by server-side schema validation with these errors:\n' +
        lastErrors.map(e => '- ' + e).join('\n') +
        '\n\nReturn the corrected JSON object only. No prose, no markdown fences.';
    }
  }

  return { ok: false, attempts, errors: lastErrors, error: transportError || null };
}

/* ------------------------------------------------------------------ */
/* Function A — extraction                                             */
/* ------------------------------------------------------------------ */

function countFilled(fields) {
  const all = Object.keys(fields);
  const filled = all.filter(k => {
    const v = fields[k];
    return v !== null && v !== undefined && v !== '' && !(Array.isArray(v) && !v.length);
  });
  return { filledCount: filled.length, totalCount: all.length };
}

/**
 * Extract the Section 7 contract fields from raw intake answers.
 * Claude (PROMPT_B) when ANTHROPIC_API_KEY is set, deterministic core.extract() otherwise.
 *
 * @returns {Promise<{fields: Object, source: 'claude'|'fallback', filledCount: number, totalCount: number, attempts?: number, validationErrors?: string[], aiError?: string}>}
 */
async function runExtract(answers, opts) {
  opts = opts || {};
  const env = opts.env || process.env;
  const list = Array.isArray(answers) ? answers : [];

  if (!anthropic.isEnabled(env) || !list.length) {
    const fields = core.extract(list);
    return Object.assign({ fields, source: 'fallback', reason: anthropic.isEnabled(env) ? 'no-answers' : 'no-api-key' }, countFilled(fields));
  }

  const answersText = list.map(a => '[' + a.id + ']: ' + a.text).join('\n');
  const res = await claudeValidatedJSON({
    systemPrompt: (core.PROMPT_B || 'Extract structured fields from intake answers.') + '\n\n' + schema.CONTRACT_SCHEMA_TEXT,
    userMessage: answersText,
    validate: schema.validateExtractedFields,
    env,
    fetchImpl: opts.fetchImpl,
    backoffMs: opts.backoffMs
  });

  if (res.ok) {
    return Object.assign({ fields: res.data, source: 'claude', attempts: res.attempts }, countFilled(res.data));
  }

  const fields = core.extract(list);
  return Object.assign({
    fields, source: 'fallback', attempts: res.attempts,
    reason: res.error ? 'ai-error' : 'schema-invalid',
    validationErrors: res.errors, aiError: res.error || null
  }, countFilled(fields));
}

/* ------------------------------------------------------------------ */
/* Function B — blueprint generation                                   */
/* ------------------------------------------------------------------ */

/**
 * Generate the blueprint from the confirmed review fields.
 * Claude (PROMPT_A) when ANTHROPIC_API_KEY is set, deterministic core.generate() otherwise.
 * The result is always schema-valid: invalid Claude output falls back.
 *
 * @returns {Promise<{blueprint: Object, source: 'claude'|'fallback', attempts?: number, validationErrors?: string[], aiError?: string}>}
 */
async function runGenerate(fields, opts) {
  opts = opts || {};
  const env = opts.env || process.env;

  if (!anthropic.isEnabled(env)) {
    return { blueprint: core.generate(fields), source: 'fallback', reason: 'no-api-key' };
  }

  const deterministic = core.generate(fields);
  const res = await claudeValidatedJSON({
    systemPrompt: (core.PROMPT_A || 'Generate a revenue operations blueprint.') + '\n\n' + schema.BLUEPRINT_SCHEMA_TEXT,
    userMessage:
      'Generate the blueprint for these confirmed review fields:\n\n' + JSON.stringify(fields, null, 2) +
      '\n\nFor reference, this is the deterministic knowledge-base v1 output for the same fields. ' +
      'Keep every figure, KB id and decision consistent with it; you may improve the wording only:\n\n' +
      JSON.stringify(deterministic, null, 2),
    validate: schema.validateBlueprint,
    env,
    fetchImpl: opts.fetchImpl,
    backoffMs: opts.backoffMs
  });

  if (res.ok) return { blueprint: res.data, source: 'claude', attempts: res.attempts };

  return {
    blueprint: deterministic, source: 'fallback', attempts: res.attempts,
    reason: res.error ? 'ai-error' : 'schema-invalid',
    validationErrors: res.errors, aiError: res.error || null
  };
}

module.exports = { runExtract, runGenerate, claudeValidatedJSON, RETRY_BACKOFF_MS };
