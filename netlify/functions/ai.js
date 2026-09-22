'use strict';
/*
 * Netlify function: /api/ai — Anthropic Claude API endpoint.
 * The ANTHROPIC_API_KEY is read server-side only, never sent to the browser.
 *
 * Endpoints:
 *   POST /api/ai/chat     — General AI chat (system prompt + user message)
 *   POST /api/ai/extract  — AI-powered extraction (Function A with Claude + Prompt B)
 *   POST /api/ai/generate — AI-powered generation (Function B with Claude + Prompt A)
 *
 * All endpoints require a valid session token.
 */
const core = require('../../lib/core');
const anthropic = require('../../lib/anthropic');
const { bodyOf, json, validateAnswers } = require('../../lib/netlify-helpers');

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') return json(405, { error: 'Method not allowed' });

  const body = bodyOf(event);
  const payload = core.verifyToken(body.token);
  if (!payload) return json(401, { error: 'Your session has ended. Enter your name and email to start again.' });

  // Determine sub-route from the path: /api/ai/chat, /api/ai/extract, /api/ai/generate
  const path = (event.path || '').replace(/^.*\/api\/ai\/?/, '') || body.action || 'chat';

  // Check if Anthropic is configured
  if (!anthropic.isEnabled(process.env)) {
    return json(503, {
      error: 'AI service is not configured. The ANTHROPIC_API_KEY environment variable is missing.',
      configured: false
    });
  }

  try {
    switch (path) {
      case 'chat':
        return await handleChat(body, payload);
      case 'extract':
        return await handleExtract(body, payload);
      case 'generate':
        return await handleGenerate(body, payload);
      default:
        return json(404, { error: 'Unknown AI action: ' + path });
    }
  } catch (e) {
    console.error('[ai] error:', e.message);
    return json(500, { error: 'An unexpected error occurred. Please try again.' });
  }
};

/**
 * General AI chat — accepts a custom system prompt and user message.
 */
async function handleChat(body, payload) {
  const systemPrompt = String(body.system_prompt || 'You are a helpful AI assistant.').slice(0, 200000);
  const userMessage = String(body.message || '').trim();

  if (!userMessage) return json(400, { error: 'Please provide a message.' });
  if (userMessage.length > 100000) return json(400, { error: 'Message is too long (max 100,000 characters).' });

  const result = await anthropic.callClaude({
    systemPrompt,
    userMessage,
    model: body.model,
    maxTokens: body.max_tokens,
    env: process.env,
    fetchImpl: globalThis.fetch
  });

  if (!result.ok) return json(502, { error: result.error });

  return json(200, {
    ok: true,
    response: result.text,
    usage: result.usage
  });
}

/**
 * AI-powered extraction (Function A with Claude + Prompt B).
 * Takes raw intake answers and returns structured fields.
 */
async function handleExtract(body, payload) {
  const v = validateAnswers(body.answers || []);
  if (!v.ok) return json(400, { error: v.error });

  const answers = body.answers || [];
  if (!answers.length) return json(400, { error: 'No answers provided.' });

  // Format the answers for the prompt
  const answersText = answers.map(a => `[${a.id}]: ${a.text}`).join('\n');

  const result = await anthropic.callClaudeJSON({
    systemPrompt: core.PROMPT_B || 'Extract structured fields from the intake answers. Return valid JSON matching the Section 7 data contract.',
    userMessage: answersText,
    env: process.env,
    fetchImpl: globalThis.fetch
  });

  if (!result.ok) return json(502, { error: result.error });

  // If Claude returned structured data, use it; otherwise fall back to deterministic
  if (result.data && typeof result.data === 'object') {
    const fields = result.data;
    const all = Object.keys(fields);
    const filled = all.filter(k => {
      const v = fields[k];
      return v !== null && v !== '' && !(Array.isArray(v) && !v.length);
    });
    return json(200, {
      ok: true,
      fields,
      filledCount: filled.length,
      totalCount: all.length,
      source: 'claude'
    });
  }

  // Fall back to deterministic extraction if Claude response wasn't parseable
  const fields = core.extract(answers);
  const all = Object.keys(fields);
  const filled = all.filter(k => JSON.stringify(fields[k]) !== 'null' && JSON.stringify(fields[k]) !== '[]' && JSON.stringify(fields[k]) !== '""');
  return json(200, {
    ok: true,
    fields,
    filledCount: filled.length,
    totalCount: all.length,
    source: 'deterministic',
    note: 'Claude response was not structured; fell back to deterministic extraction.'
  });
}

/**
 * AI-powered generation (Function B with Claude + Prompt A).
 * Takes structured fields and generates a blueprint.
 */
async function handleGenerate(body, payload) {
  const fields = body.fields || {};
  try {
    if (JSON.stringify(fields).length > 100000) return json(400, { error: 'Fields payload too large.' });
  } catch (e) {
    return json(400, { error: 'Invalid fields data.' });
  }

  // Validate required fields
  const required = ['typical_deal_size', 'monthly_lead_volume', 'close_rate'];
  const missing = required.filter(k => fields[k] == null || isNaN(fields[k]) || fields[k] <= 0);
  if (missing.length) {
    return json(400, { error: 'Required fields missing: ' + missing.join(', ') });
  }
  if (!fields.close_type) {
    return json(400, { error: 'Close type (one-call or two-call) is required.' });
  }

  const fieldsJSON = JSON.stringify(fields, null, 2);

  const result = await anthropic.callClaudeJSON({
    systemPrompt: core.PROMPT_A || 'Generate a revenue operations blueprint from the provided fields. Return valid JSON matching the blueprint schema.',
    userMessage: 'Generate the blueprint for these confirmed review fields:\n\n' + fieldsJSON,
    env: process.env,
    fetchImpl: globalThis.fetch
  });

  if (!result.ok) return json(502, { error: result.error });

  // If Claude returned structured data, use it; otherwise fall back to deterministic
  if (result.data && typeof result.data === 'object' && result.data.meta) {
    return json(200, { ok: true, blueprint: result.data, source: 'claude' });
  }

  // Fall back to deterministic generation
  const blueprint = core.generate(fields);
  return json(200, {
    ok: true,
    blueprint,
    source: 'deterministic',
    note: 'Claude response was not a valid blueprint; fell back to deterministic generation.'
  });
}
