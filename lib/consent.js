'use strict';
/*
 * Consent and disclosure handling.
 *
 * - CONSENT_VERSION: notice version for audit.
 * - getPrivacyPolicyUrl(env): returns https URL or null, logs warning if unset/invalid.
 * - buildNoticeText / buildNoticeHtml: short notice for entry gate and consent screen.
 */

const CONSENT_VERSION = 'v1-2026-09-28';

function getPrivacyPolicyUrl(env) {
  env = env || process.env;
  const raw = String(env.PRIVACY_POLICY_URL || '').trim();
  if (!raw) {
    console.warn('[consent] PRIVACY_POLICY_URL is not set — showing notice without link. A real privacy policy is required before public launch.');
    return null;
  }
  try {
    const u = new URL(raw);
    if (u.protocol !== 'https:') {
      console.warn('[consent] PRIVACY_POLICY_URL must be https, got ' + u.protocol + ' — treating as unset. A real privacy policy is required before public launch.');
      return null;
    }
    return u.toString();
  } catch (e) {
    console.warn('[consent] PRIVACY_POLICY_URL is not a valid URL (' + raw + ') — treating as unset. A real privacy policy is required before public launch.');
    return null;
  }
}

function escHtml(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function buildNoticeText(privacyUrl) {
  const base = 'Nova is an AI assistant. Your name, email and answers are saved to our CRM (HubSpot) so our team can follow up. The voice call is processed by OpenAI and your blueprint by Anthropic\'s Claude. Audio is never stored.';
  if (privacyUrl) return base + ' Privacy Policy: ' + privacyUrl;
  return base;
}

function buildNoticeHtml(privacyUrl) {
  const base = 'Nova is an AI assistant. Your name, email and answers are saved to our CRM (HubSpot) so our team can follow up. The voice call is processed by OpenAI and your blueprint by Anthropic\'s Claude. Audio is never stored.';
  if (privacyUrl) {
    return escHtml(base) + ' <a href="' + escHtml(privacyUrl) + '" target="_blank" rel="noopener noreferrer">Privacy Policy</a>.';
  }
  return escHtml(base);
}

// Consent screen specific: plainly state you'll be speaking with Nova, an AI, repeat CRM line and privacy link
function buildConsentNoticeHtml(privacyUrl) {
  const lines = [
    "You'll be speaking with Nova, an AI.",
    "Your name, email and answers are saved to our CRM (HubSpot) so our team can follow up.",
    "The voice call is processed by OpenAI and your blueprint by Anthropic's Claude. Audio is never stored."
  ];
  let html = lines.map(l => '<p>' + escHtml(l) + '</p>').join('');
  if (privacyUrl) {
    html += '<p><a href="' + escHtml(privacyUrl) + '" target="_blank" rel="noopener noreferrer">Privacy Policy</a></p>';
  }
  return html;
}

function buildConsentNoteLine(consentAt, version, privacyUrl) {
  const v = version || CONSENT_VERSION;
  const at = consentAt || new Date().toISOString();
  let line = `Consent: given at ${at} (version ${v})`;
  if (privacyUrl) line += `, privacy policy ${privacyUrl}`;
  return line;
}

module.exports = {
  CONSENT_VERSION,
  getPrivacyPolicyUrl,
  buildNoticeText,
  buildNoticeHtml,
  buildConsentNoticeHtml,
  buildConsentNoteLine
};
