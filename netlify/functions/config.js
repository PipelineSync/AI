'use strict';
/* Netlify function: GET /api/config — public safe config for the frontend.
 * Returns schedulerLink if SCHEDULER_LINK is set. Never exposes HUBSPOT_ACCESS_TOKEN.
 * Also returns turnstileSiteKey (public) and demoMode flag when DEMO_MODE=true.
 * Returns privacyPolicyUrl (https only) and consentVersion.
 */
const { json } = require('../../lib/netlify-helpers');
const turnstile = require('../../lib/turnstile');
const consent = require('../../lib/consent');
const autopilot = require('../../lib/autopilot');

exports.handler = async (event) => {
  if (event.httpMethod !== 'GET' && event.httpMethod !== 'POST') return json(405, { error: 'Method not allowed' });
  const link = String(process.env.SCHEDULER_LINK || '').trim();
  const siteKey = turnstile.getSiteKey(process.env);
  const demoMode = turnstile.isDemoModeEnabled(process.env);
  const privacyUrl = consent.getPrivacyPolicyUrl(process.env);
  const out = {
    ok: true,
    schedulerLink: link || null,
    hubspotEnabled: !!String(process.env.HUBSPOT_ACCESS_TOKEN || process.env.HUBSPOT_API_KEY || '').trim(),
    privacyPolicyUrl: privacyUrl || null,
    consentVersion: consent.CONSENT_VERSION,
    // Zero-touch: the browser runs call -> blueprint -> PDF with no review or unlock screen.
    // See lib/autopilot.js; AUTO_DELIVER=false is the manual flow.
    autoDeliver: autopilot.isEnabled(process.env)
  };
  if (siteKey && turnstile.getSecret(process.env)) {
    out.turnstileSiteKey = siteKey;
  }
  if (demoMode) out.demoMode = true;
  return json(200, out);
};
