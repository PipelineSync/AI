'use strict';
/*
 * Anthropic Claude API client — server-side only.
 * The API key NEVER reaches the browser. It is read from ANTHROPIC_API_KEY
 * in the process environment (set in .env locally, or Netlify env vars).
 *
 * Used by:
 *   - server.js               (local dev: /api/ai, /api/extract, /api/generate)
 *   - netlify/functions/ai.js (deployed: /.netlify/functions/ai)
 */

const ANTHROPIC_URL = 'https://api.anthropic.com/v1/messages';
const ANTHROPIC_VERSION = '2023-06-01';
const DEFAULT_MODEL = 'claude-sonnet-5';
const DEFAULT_MAX_TOKENS = 4096;

/**
 * Check whether the Anthropic API key is configured.
 */
function isEnabled(env) {
  const key = (env || process.env).ANTHROPIC_API_KEY;
  return !!(key && key.trim().length > 10);
}

/**
 * Call the Anthropic Claude API.
 *
 * @param {Object} opts
 * @param {string} opts.systemPrompt - System prompt describing the assistant's role
 * @param {string} opts.userMessage  - The user's input
 * @param {string} [opts.model]      - Model name (default: claude-sonnet-5)
 * @param {number} [opts.maxTokens]  - Max response tokens (default: 4096)
 * @param {Object} [opts.env]        - Environment object (defaults to process.env)
 * @param {Function} [opts.fetchImpl] - Fetch implementation (defaults to global fetch)
 * @returns {Promise<{ok: boolean, text?: string, error?: string, usage?: Object}>}
 */
async function callClaude({ systemPrompt, userMessage, model, maxTokens, env, fetchImpl }) {
  const apiKey = (env || process.env).ANTHROPIC_API_KEY;
  if (!apiKey) {
    return { ok: false, error: 'ANTHROPIC_API_KEY is not configured on the server.' };
  }

  const fetchFn = fetchImpl || (typeof fetch !== 'undefined' ? fetch : null);
  if (!fetchFn) {
    return { ok: false, error: 'No fetch implementation available on the server.' };
  }

  // Input validation
  if (!userMessage || typeof userMessage !== 'string' || userMessage.trim().length === 0) {
    return { ok: false, error: 'No input provided to the AI.' };
  }
  if (userMessage.length > 100000) {
    return { ok: false, error: 'Input is too long (max 100,000 characters).' };
  }
  if (systemPrompt && systemPrompt.length > 200000) {
    return { ok: false, error: 'System prompt is too long.' };
  }

  const body = {
    model: model || DEFAULT_MODEL,
    max_tokens: maxTokens || DEFAULT_MAX_TOKENS,
    system: systemPrompt || 'You are a helpful AI assistant.',
    messages: [{ role: 'user', content: userMessage }]
  };

  let res;
  try {
    res = await fetchFn(ANTHROPIC_URL, {
      method: 'POST',
      headers: {
        'x-api-key': apiKey,
        'anthropic-version': ANTHROPIC_VERSION,
        'content-type': 'application/json'
      },
      body: JSON.stringify(body)
    });
  } catch (e) {
    return { ok: false, error: 'Could not reach the AI service: ' + e.message };
  }

  if (!res.ok) {
    let errBody = '';
    try { errBody = await res.text(); } catch (e) {}
    let errMsg = 'AI service returned HTTP ' + res.status;
    try {
      const parsed = JSON.parse(errBody);
      if (parsed.error && parsed.error.message) errMsg = parsed.error.message;
    } catch (e) {}
    // Map common errors to user-friendly messages
    if (res.status === 401) errMsg = 'The AI service key is invalid. Please check the server configuration.';
    if (res.status === 429) errMsg = 'The AI service is busy. Please wait a moment and try again.';
    if (res.status === 529) errMsg = 'The AI service is temporarily overloaded. Please try again shortly.';
    if (res.status >= 500) errMsg = 'The AI service encountered an internal error. Please try again.';
    return { ok: false, error: errMsg };
  }

  let data;
  try {
    data = await res.json();
  } catch (e) {
    return { ok: false, error: 'Could not parse the AI response.' };
  }

  // Extract text from response: data.content[0].text
  const text = data && data.content && data.content[0] && data.content[0].text;
  if (!text) {
    return { ok: false, error: 'The AI returned an empty response.' };
  }

  const usage = data.usage || null;
  return { ok: true, text, usage };
}

/**
 * Call Claude and parse the response as JSON.
 * Falls back gracefully if the response is not valid JSON.
 *
 * @param {Object} opts - Same as callClaude
 * @returns {Promise<{ok: boolean, data?: Object, text?: string, error?: string}>}
 */
async function callClaudeJSON(opts) {
  const result = await callClaude(opts);
  if (!result.ok) return result;

  // Try to parse JSON from the response
  let text = result.text.trim();
  // Strip markdown code fences if present
  text = text.replace(/^```(?:json)?\s*\n?/i, '').replace(/\n?```\s*$/i, '').trim();

  try {
    const data = JSON.parse(text);
    return { ok: true, data, text: result.text, usage: result.usage };
  } catch (e) {
    // If JSON parsing fails, return the raw text with a flag
    return { ok: true, data: null, text: result.text, usage: result.usage, parseError: 'Response was not valid JSON.' };
  }
}

module.exports = { isEnabled, callClaude, callClaudeJSON, ANTHROPIC_URL, ANTHROPIC_VERSION };
