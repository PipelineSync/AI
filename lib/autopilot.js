'use strict';
/*
 * Zero-touch mode (AUTO_DELIVER) - one place that decides it.
 *
 * The journey the client asked for is: name + email, the AI voice call, and then the
 * Anthropic-built blueprint as a PDF, with nothing to click in between. That last part is this
 * switch. When it is on:
 *
 *   1. the browser runs the journey unattended (public/app.js): after the call it structures the
 *      answers, generates the blueprint and delivers the PDF without a review or unlock screen;
 *   2. /api/deliver accepts `auto: true` for the FIRST delivery to the address the signed session
 *      was created with, without an emailed 6-digit code, so a delivery never stalls on a code
 *      the visitor has to go and fetch;
 *   3. the AI's closing line changes: Nova says the blueprint is being written and emailed now,
 *      instead of telling the visitor to "review and correct what we captured on screen", because
 *      in this mode there is no review screen waiting for them.
 *
 * What does NOT change, and must not:
 *   - the required figures (typical deal size, monthly lead volume, close rate) are still required
 *     before the blueprint can be grounded. If the call ended without one, the browser asks for
 *     just that number instead of inventing it;
 *   - consent is still required (body.consent === true) and is recorded on the CRM note;
 *   - the per-email daily cap, the global daily cap and the per-IP rate limit still apply;
 *   - only the first automatic delivery skips the code. A repeat call finds the idempotency
 *     record and returns the same PDF without sending anything again, and the manual
 *     "email me a copy" path still needs the code when EMAIL_VERIFY is on.
 *
 * Set AUTO_DELIVER=false to put the review screen and the code step back in front of the send.
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

/* The manual, code-verified delivery path the operator gets back by setting AUTO_DELIVER=false. */
function publicConfig(env) {
  return { autoDeliver: isEnabled(env) };
}

/* One startup line, so an operator can see the mode without reading the code. When the automatic
   send is on while the emailed code is also on, say the trade-off out loud: the first delivery
   goes out without a code, which is exactly the point of zero-touch and exactly what the code was
   there to stop. Never block - the operator can set either variable. */
function startupNote(env) {
  env = env || process.env;
  if (!isEnabled(env)) {
    return 'Zero-touch delivery: off (AUTO_DELIVER=false) - the review screen and the email code step are back in front of the send.';
  }
  const verifyRaw = String(env.EMAIL_VERIFY || '').trim().toLowerCase();
  const verifyOn = verifyRaw !== 'false' && verifyRaw !== '0' && verifyRaw !== 'no' && verifyRaw !== 'off';
  if (verifyOn) {
    return 'Zero-touch delivery: ON - after the call the blueprint is built and the PDF is emailed automatically to the address from the entry gate. EMAIL_VERIFY is also on, so only the first automatic delivery skips the code; set AUTO_DELIVER=false for the manual review + code flow.';
  }
  return 'Zero-touch delivery: ON - after the call the blueprint is built and the PDF is emailed automatically, with no review or unlock screen.';
}

module.exports = { isEnabled, publicConfig, startupNote, DEFAULT_AUTO_DELIVER };
