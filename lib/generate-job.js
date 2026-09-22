'use strict';
/*
 * The blueprint generation job: validation, Claude/fallback generation, Supabase
 * persistence and job-store bookkeeping.
 *
 * Shared by netlify/functions/generate.js (dispatcher), generate-background.js
 * (worker) and server.js (local dev), so there is one behaviour everywhere.
 */

const ai = require('./ai-pipeline');
const leads = require('./supabase-leads');
const jobs = require('./job-store');

/* Progress states the client renders. Real states, not a sleep animation. */
const STEPS = ['validating', 'generating', 'validating_output', 'saving', 'done'];

function progressFor(step) {
  const i = STEPS.indexOf(step);
  return i < 0 ? 0 : Math.round((i / (STEPS.length - 1)) * 100);
}

const LABELS = {
  queued: 'Queued',
  validating: 'Checking your confirmed numbers',
  generating: 'Writing your blueprint',
  validating_output: 'Validating the blueprint against the schema',
  saving: 'Saving your blueprint',
  done: 'Blueprint ready',
  error: 'Generation failed'
};

async function setStep(jobId, step, extra, opts) {
  return jobs.put(jobId, Object.assign({
    status: step === 'done' ? 'done' : (step === 'error' ? 'error' : 'running'),
    step,
    label: LABELS[step] || step,
    progress: step === 'error' ? 100 : progressFor(step)
  }, extra || {}), opts);
}

/**
 * Run the whole generation for a job id. Never throws: failures land in the job record.
 *
 * @param {string} jobId
 * @param {Object} fields   - already server-validated review fields
 * @param {Object} payload  - the verified token payload (for lead_id)
 * @param {Object} [opts]   - { env, fetchImpl }
 */
async function runJob(jobId, fields, payload, opts) {
  opts = opts || {};
  const env = opts.env || process.env;
  try {
    await setStep(jobId, 'generating', null, { env });
    const result = await ai.runGenerate(fields, { env, fetchImpl: opts.fetchImpl });
    if (result.source === 'fallback' && result.reason && result.reason !== 'no-api-key') {
      console.warn('[generate] Claude output unusable (' + result.reason + '):', JSON.stringify(result.validationErrors || result.aiError));
    }
    await setStep(jobId, 'validating_output', { source: result.source }, { env });

    const blueprint = result.blueprint;
    if (payload && payload.lead_id && leads.isEnabled(env)) {
      await setStep(jobId, 'saving', { source: result.source }, { env });
      try {
        const now = new Date().toISOString();
        await leads.saveSession(payload.lead_id, { status: 'completed', extracted_fields: fields, completed_at: now }, { env });
        await leads.saveBlueprint(payload.lead_id, blueprint, { generated_at: now }, { env });
        await leads.updateLead(payload.lead_id, {
          status: 'blueprint_generated', blueprint_generated_at: now,
          industry: fields.industry || null, company: fields.business_description || null
        }, { env });
        await leads.addEvent(payload.lead_id, 'blueprint_generated', {}, { env });
      } catch (e) {
        console.error('[generate] Supabase persistence failed:', e.message);
        await jobs.put(jobId, {
          status: 'error', step: 'error', label: LABELS.error, progress: 100,
          error: 'Your blueprint was generated, but we could not save it. Please try again.'
        }, { env });
        return { ok: false, error: 'persistence' };
      }
    }

    await jobs.put(jobId, {
      status: 'done', step: 'done', label: LABELS.done, progress: 100,
      source: result.source, blueprint
    }, { env });
    return { ok: true, blueprint, source: result.source };
  } catch (e) {
    console.error('[generate] job failed:', e && e.message);
    await jobs.put(jobId, {
      status: 'error', step: 'error', label: LABELS.error, progress: 100,
      error: 'We could not generate your blueprint. Please try again.'
    }, { env });
    return { ok: false, error: 'exception' };
  }
}

module.exports = { runJob, setStep, progressFor, STEPS, LABELS };
