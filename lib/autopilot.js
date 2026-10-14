'use strict';
/*
 * Zero-touch mode (AUTO_DELIVER) - one place that decides it.
 *
 * The journey: name + email, the AI voice call, then the Anthropic-built blueprint as a PDF that
 * downloads in the web app. The PDF is never emailed, in either mode. When this switch is on:
 *
 *   1. the browser runs the journey unattended (public/app.js): after the call it structures the
 *      answers, generates the blueprint and downloads the PDF without an unlock click;
 *   2. /api/deliver accepts `auto: true`, carrying the consent given on the consent screen with
 *      its timestamp, so the CRM note records when the visitor agreed;
 *   3. the AI's closing line says the blueprint is being written and will download on screen.
 *
 * What does NOT change, and must not:
 *   - the required figures (typical deal size, monthly lead volume, close rate, close type) are
 *     still required before the blueprint can be grounded. If the call ended without one, the
 *     browser asks for just that instead of inventing it;
 *   - consent is still required (body.consent === true) and is recorded on the CRM note;
 *   - the per-email daily cap and the per-IP rate limit still apply, and a repeat call returns
 *     the same PDF without a second CRM record.
 *
 * Set AUTO_DELIVER=false for the manual path: the blueprint still appears straight after the call
 * (there is no review screen in either mode), and the visitor ticks consent and clicks to unlock
 * the official PDF.
 */

const DEFAULT_AUTO_DELIVER = true;
const TRUE = ['1', 'true', 'yes', 'on'];
const FALSE = ['0', 'false', 'no', 'off'];

function isEnabled(env) {
  const raw = String(((env || process.env).AUTO_DELIVER) || '').trim().toLowerCase();
  if (TRUE.indexOf(raw) >= 0) return true;
  if (FALSE.indexOf(raw) >= 0) return false;
  return DEFAULT_AUTO_DELIVER;
}

/* The browser only needs to know which mode it is in. */
function publicConfig(env) {
  return { autoDeliver: isEnabled(env) };
}

/* One startup line, so an operator can see the mode without reading the code. */
function startupNote(env) {
  env = env || process.env;
  if (!isEnabled(env)) {
    return 'Zero-touch delivery: off (AUTO_DELIVER=false) - the blueprint shows after the call and the visitor clicks to unlock and download the PDF. Nothing is emailed.';
  }
  return 'Zero-touch delivery: ON - after the call the blueprint is built and the PDF downloads in the app automatically, with no unlock click. Nothing is emailed.';
}

module.exports = { isEnabled, publicConfig, startupNote, DEFAULT_AUTO_DELIVER };
