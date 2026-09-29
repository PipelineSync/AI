# Consent and disclosure fixes — Summary per file

## Baseline
After HubSpot fixes, `npm run test:all` reported 12 files, 1012 PASS, 0 FAIL. Now after consent fixes, 13 files (added consent.js), 1093 PASS, 0 FAIL.

## Requirements

1. Entry form (start view): under name/email fields, add short notice: "Nova is an AI assistant. Your name, email and answers are saved to our CRM (HubSpot) so our team can follow up. The voice call is processed by OpenAI and your blueprint by Anthropic's Claude. Audio is never stored." plus Privacy Policy link.
2. New env PRIVACY_POLICY_URL, returned by /api/config. Must be https; otherwise treat as unset. If unset, log server warning and show notice without link. Document real policy required before public launch.
3. Consent screen (app.js:1864-1878): state plainly "You'll be speaking with Nova, an AI". Repeat CRM line and privacy link. Checkbox must start UNCHECKED, button disabled until ticked.
4. Record consent: include consent_at and notice version (CONSENT_VERSION constant) in Supabase lead event and as line in HubSpot note.
5. ui-smoke tests: notice + link render when PRIVACY_POLICY_URL set; checkbox starts unchecked; button disabled until checked.

## Files changed

### lib/consent.js (new)
- `CONSENT_VERSION = 'v1-2026-09-28'` constant for audit.
- `getPrivacyPolicyUrl(env)`: returns https URL or null, logs warning if unset/invalid/non-https: "[consent] PRIVACY_POLICY_URL is not set — showing notice without link. A real privacy policy is required before public launch." etc.
- `buildNoticeHtml(privacyUrl)`, `buildNoticeText`: builds disclosure notice with optional link, HTML-escaped.
- `buildConsentNoticeHtml(privacyUrl)`: consent screen version with "You'll be speaking with Nova, an AI." + CRM line + audio never stored + privacy link.
- `buildConsentNoteLine(consentAt, version, privacyUrl)`: `Consent: given at ${at} (version ${v}), privacy policy ${url}`.

### netlify/functions/config.js
- Imports `lib/consent`, calls `getPrivacyPolicyUrl`, returns `privacyPolicyUrl` (null if unset/invalid) and `consentVersion`. Validates https only.

### server.js
- `/api/config` handler same: returns `privacyPolicyUrl` and `consentVersion` via consent module.
- `/api/lead/progress` handler: now captures `consent_at`, `consent_version`, `privacy_policy_url` from body when status is `discovery_started`, includes in `addEvent` event_data (fallback to now and CONSENT_VERSION if not provided).

### netlify/functions/lead.js
- Same as server.js: extracts consent fields from body for `discovery_started` event, stores in Supabase event.

### lib/hubspot.js
- `createNoteForContact` now takes extra param `consentInfo`, builds consent line via `consent.buildConsentNoteLine(at, version, privacyUrl)` and includes in note body.
- `pushLead` signature added `consentInfo`, passes to `createNoteForContact`.
- Note body now includes consent line + existing droppedProps + audio_retained.

### lib/deliver-core.js
- Imports `lib/consent`.
- At HubSpot push, generates `consentAt = new Date().toISOString()`, `consentVersion = CONSENT_VERSION`, `privacyUrl = getPrivacyPolicyUrl(env)`, passes as `consentInfo` to `pushLead`.
- Supabase `blueprint_delivered` event now includes `consent_at`, `consent_version`, `privacy_policy_url`.

### public/app.js
- **State**: added `privacyPolicyUrl: null`, `consentVersion: null`, `consent: {at, version, privacyPolicyUrl}`.
- **fetchConfig**: now handles `privacyPolicyUrl` and `consentVersion` from `/api/config`, triggers render if changed.
- **startView**: added `entryNotice` div with id `entry-consent-notice` containing required disclosure text plus optional privacy link (`state.privacyPolicyUrl`). Placed under email field, before Turnstile. Previously only had gate-note "Live transcription. Audio is never stored." Now full notice per requirement.
- **consentView**: rewritten to include `<p>You'll be speaking with Nova, an AI.</p>` + notice div `id="consent-notice"` with CRM line + OpenAI + Claude + audio never stored + optional privacy link. Checkbox `#consent-cb` still unchecked by default, button `#consent-go` disabled. `bindConsent` already disables until checked, now also explicitly tests that.
- **beginCall**: generates `consentAt` timestamp, stores in `state.consent` and localStorage `ps_consent`, calls `trackLeadProgress('discovery_started', {consent_at, consent_version, privacy_policy_url})`.

### test/ui-smoke.js
- **passGate**: added pre-submit check for `#entry-consent-notice` containing "Nova is an AI assistant", "saved to our CRM (HubSpot)", "OpenAI" + "Claude", "Audio is never stored". Previously no entry notice checks.
- **reachCall**: added checks:
  - `consent-cb` starts unchecked
  - `consent-go` disabled until ticked
  - After tick, enabled
  - Consent screen text includes "You'll be speaking with Nova, an AI" and CRM line.
- **New Scenario 5**: starts server with `PRIVACY_POLICY_URL=https://example.com/privacy`, boots page, checks entry notice link href equals privacy URL, consent notice link href equals privacy URL, checkbox unchecked, button disabled, enabled after check, disabled after uncheck, AI disclosure present, no runtime errors.

### test/consent.js (new)
- Tests `getPrivacyPolicyUrl` https validation (https accepted, http/invalid/empty → null).
- Tests `CONSENT_VERSION` exists.
- Tests `buildNoticeHtml` contains required lines and privacy link when set, no href when unset.
- Tests `buildConsentNoticeHtml` contains AI line and CRM line and privacy link.
- Tests `buildConsentNoteLine` includes at, version, url.
- Tests config returns `privacyPolicyUrl` only when https, otherwise null, and returns `consentVersion`.
- Tests lead progress stores `consent_at`, `consent_version`, `privacy_policy_url` via mocked `addEvent`.
- Tests HubSpot note includes consent line.
- Tests server config returns privacy url and consentVersion, http treated as unset.

### .env.example
- Added Phase consent section with commented `PRIVACY_POLICY_URL=https://yourdomain.com/privacy` and note that real policy required before public launch.

### README.md
- Added row for `PRIVACY_POLICY_URL` with description: must be https, returned by `/api/config`, warning if unset, real policy required before public launch.

## Changed assertions old vs new

| File | Old | New | Why |
|---|---|---|---|
| public/app.js startView | Only gate-note "Live transcription. Audio is never stored." | Added `#entry-consent-notice` with full disclosure: Nova AI assistant, CRM HubSpot, OpenAI + Claude, audio never stored + optional Privacy Policy link | Entry gate pushes to HubSpot at start.js:34, so notice must appear at or before that point |
| public/app.js consentView | Notice: "OpenAI for the voice call. Audio is never stored." + generic privacy, no AI identity line | Notice: "You'll be speaking with Nova, an AI." + CRM line + OpenAI + Claude + audio never stored + privacy link; checkbox unchecked, button disabled | Plain disclosure required, checkbox must start unchecked and button disabled until ticked |
| test/ui-smoke.js passGate | No entry notice checks | Checks entry notice contains AI disclosure, CRM, OpenAI, Claude, audio never stored | Covers new entry notice requirement |
| test/ui-smoke.js reachCall | Only checked disclaimer names OpenAI, consent note says starts speaking | Added checks: checkbox starts unchecked, button disabled, after tick enabled, consent says "You'll be speaking with Nova, an AI", repeats CRM line | Covers checkbox unchecked + button disabled requirement |
| test/ui-smoke.js new scenario | No privacy link test | Added scenario 5 with PRIVACY_POLICY_URL set, checks entry and consent notices show link href | Proves privacy link renders when env set |
| netlify/functions/config.js | Returned only schedulerLink, turnstileSiteKey, demoMode | Now also returns privacyPolicyUrl (https only) and consentVersion | New env requirement |
| server.js /api/config | Same as above old | Same new | Same |
| lead.js / server.js lead progress | Event data {} for discovery_started | Now includes consent_at, consent_version, privacy_policy_url | Record consent for audit |
| hubspot.js note | No consent line | Includes `Consent: given at ... (version ...)` line | Record consent in CRM |
| deliver-core.js | No consent in HubSpot note or Supabase event | Includes consent_at, version, privacy url in both | Record consent |

No existing assertion deleted; all new assertions added, old ones updated to reflect intentional disclosure changes.

## Test results
Before: 12 files, 1012 PASS, 0 FAIL.
After: 13 files (added consent.js), 1093 PASS, 0 FAIL.

## Env vars
- `PRIVACY_POLICY_URL` (https only) — documented in `.env.example` commented and README table, with note that real policy required before public launch. Returns null if not https, logs server warning.

## Conventions
- No new npm deps.
- Same code path for Netlify functions and `server.js`.
- Secrets server-side only.
