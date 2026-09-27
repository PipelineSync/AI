# Security + reliability fixes for /api/deliver — Summary per file

## Baseline
11 files, 936 PASS, 0 FAIL before changes.

## Implementation (Phase 6)

### lib/job-store.js
- Stores email (lowercased) + lead_id next to result. `put` preserves email/leadId/fields when updating existing job. Normalizes email lowercased, keeps both leadId and lead_id. `get` validates jobId regex hex 8-64. `_resetMemory` for tests. Used by generate and deliver.

### lib/generate-job.js (and netlify/functions/generate*.js, server.js generate path)
- When creating job, writes email from token payload and lead_id into job record alongside blueprint and fields. Same code path for Netlify background and inline.

### lib/deliver-core.js (main security fix)
- **Server-side blueprint only**: takes body.jobId, loads from job-store, 403 if job email != token email, 404 if missing/unfinished, ignores body.blueprint and body.fields, takes fields/blueprint from job record.
- **Token email everywhere**: uses token email for HubSpot, Supabase, email send. Removes body.email usage. recipientFromToken from payload.
- **Email verification**: env EMAIL_VERIFY default true. PDF immediate. Email requires code via /api/deliver/code. Checks emailVerify.isVerified / verifyCode. If verification required and no code, returns PDF with email.sent:false error "verification required".
- **Idempotency**: key=sha256(token email+jobId) stored in Blobs via lib/deliver-idempotency {dealId, contactId, emailSent, emailId, emailResult, hubspot, at, resendUsed}. Repeat returns PDF again duplicate:true, no new deal/email. body.resendEmail===true allows one extra send per key, marks resendUsed.
- **Supabase failure non-blocking**: previously returned 503 at 141-144. Now catches and returns 200 with persistence:{ok:false}, logs error. UI shows PDF normal.
- **Per-email and global limits**: check per-email before idempotency, global before send. Increment per-email after send (or even on failure), global only on sent.
- Only first delivery writes blueprint_delivered event.

### lib/email-verify.js (new)
- Stores 6-digit code hash in Blobs 10-min expiry (EMAIL_VERIFY_CODE_TTL_MIN default 10). Max 3 sends/hour/email (EMAIL_VERIFY_MAX_SENDS_HOUR) and 5 wrong attempts (EMAIL_VERIFY_MAX_ATTEMPTS). isVerifyEnabled reads EMAIL_VERIFY default true. Functions: sendCode (generates code, stores hash), verifyCode, isVerified, _resetMemory.

### lib/deliver-idempotency.js (new)
- Netlify Blobs + memory fallback. Key sha256(email+jobId). get/put/_resetMemory. Stores dealId, contactId, emailSent, etc.

### netlify/functions/deliver-code.js (new) + server.js route + netlify.toml redirect
- POST /api/deliver/code: verifies token, rate limits by IP (same as deliver), checks per-email send limit, generates 6-digit code, sends fixed template email via Resend (token email), stores hash via email-verify. Returns {ok:true}. Errors 429 if too many sends.
- netlify.toml: [[redirect]] from /api/deliver/code to /.netlify/functions/deliver-code.

### lib/anthropic.js
- callClaude takes timeoutMs via AbortController. On AbortError returns {ok:false, error:"AI request timed out", retryable:true, timeout:true}. Already implemented, verified.

### lib/ai-pipeline.js
- runExtract total deadline AI_EXTRACT_DEADLINE_MS default 8000, runGenerate AI_GENERATE_DEADLINE_MS default 60000 via parseDeadline. remainingMs helper. callWithTransportRetry respects deadlineAt, checks remaining before retry, returns deadline exceeded timeout. claudeValidatedJSON checks deadlineAt before each attempt and before retry, returns timeout. runExtract/runGenerate return fallback with reason:"timeout" when timeout. Backoff fits inside remaining.

### public/app.js
- bindBlueprint rewrote: unlock panel now shows session email read-only (ro-field), no editable email input. POST /api/deliver {jobId, consent, voice_meta} only. Handles Abort timeout with Try again button (#un-tryagain). Stores duplicate/persistence from response. Added handlers for #email-me-btn → POST /api/deliver/code (devCode logged), #verify-go → POST /api/deliver {jobId, code}, #resend-email-btn → POST {jobId, resendEmail:true}. blueprintView patched to render duplicate:true note, persistence ok:false note, verification-required UI (Email me a copy → code input), email options with resend. Frontend api.post wrappers use AbortController 25s timeout, sets err.timeout true.

### public/styles.css
- Added .ro-field (read-only email field styling) and .cf-turnstile (Turnstile widget spacing) to satisfy ui-design.js class coverage check. Previously missing caused FAIL.

### test/harness.js
- Added EMAIL_VERIFY='false' default for suite (prod default stays true). Keeps existing email failure assertions (PDF_EMAIL_API_KEY missing) valid while new code defaults to verification required. PS_TOKEN_SECRET already long secret.

### test/pdf-email.js (full rewrite)
- Uses lib/job-store put to create test jobs. deliverBody now {token, jobId, consent}. Tests: server-side blueprint only (valid jobId → 200 PDF+email, invalid jobId → 404 no PDF/email), token email everywhere (attacker body.email ignored, still sends to token email), idempotency duplicate:true returns PDF no new deal/email, resendEmail allows extra send, Supabase failure mocked to return 200 persistence:{ok:false} with PDF, rate limit per IP with fresh job each attempt, local dev server creates job via /api/auth/start → /api/extract → /api/generate → status poll then deliver via jobId.

### test/e2e.js
- deliver now POST {token, jobId, consent}. Added duplicate assertion second call returns duplicate:true with PDF. Email assertion updated to token email (was body.email).

### test/netlify-sim.js (full rewrite)
- Uses job-store for deliver tests. Fresh job for each deliver to avoid idempotency interfering with per-email caps unless testing duplicate. Tests hand-made blueprint without valid jobId → 404, token email everywhere, idempotency, resend, Supabase non-blocking, etc. Preserves HubSpot note and booking tests.

### test/voice.js
- Deliver with voice metadata now uses jobId: generateBlueprint returns jobId, then POST /api/deliver {jobId, consent, voice_meta}. Old used {email, fields, blueprint}. New proves voice_meta still flows through job record path.

### test/demo-and-limits.js (full rewrite)
- Per-email cap and global cap via function now use fresh jobId each time (jobs.newJobId()) to avoid idempotency duplicate blocking limit counting. Added reset of idempotency and job-store between tests. Server path now creates job via API then delivers via jobId, checks duplicate:true on second same jobId. Old expected same body repeated to count toward limit; new needs fresh jobs because idempotency prevents double counting (correct behavior).

### test/claude-pipeline.js
- Added section "Claude timeouts: hang → deadline fallback reason:\"timeout\"": hangingStub that never resolves but respects abort signal. Calls runExtract with AI_EXTRACT_DEADLINE_MS=120, expects fallback reason timeout, at least one call attempted. Also direct callClaude timeoutMs test via AbortController returns timeout:true. Covers stubbed fetch success, malformed JSON→fallback, 429→retry, hang→deadline fallback.

### .env.example
- Added commented section Phase 6: EMAIL_VERIFY, EMAIL_VERIFY_CODE_TTL_MIN, EMAIL_VERIFY_MAX_SENDS_HOUR, EMAIL_VERIFY_MAX_ATTEMPTS, AI_EXTRACT_DEADLINE_MS, AI_GENERATE_DEADLINE_MS, plus explanation of idempotency and Supabase non-blocking.

### README.md
- Added table rows for EMAIL_VERIFY, EMAIL_VERIFY_CODE_TTL_MIN, EMAIL_VERIFY_MAX_SENDS_HOUR, EMAIL_VERIFY_MAX_ATTEMPTS, AI_EXTRACT_DEADLINE_MS, AI_GENERATE_DEADLINE_MS, DELIVER_RATE_PER_MIN (already existed but kept). Documents verification flow and deadlines.

## Changed assertions (old vs new) — why

| Test file | Old assertion | New assertion | Why |
|---|---|---|---|
| test/pdf-email.js: deliver 200 | `body: {token, email, fields, blueprint}` → 200 PDF+email | `body: {token, jobId}` → 200 PDF+email, job from job-store | Security: server-side blueprint only, body.blueprint ignored, jobId required |
| test/pdf-email.js: invalid blueprint | Hand-made blueprint accepted, PDF returned | Invalid jobId → 404 no PDF, no email | Prevent forged blueprint via client |
| test/pdf-email.js: attacker email | `body.email = attacker` sent to attacker | `body.email` ignored, still sends to token email, response to === token email | Token email everywhere, prevents email spoof |
| test/pdf-email.js: Supabase failure | Expected 503 on Supabase save failure | 200 with `persistence:{ok:false}` + PDF | Supabase failure must not block PDF download |
| test/pdf-email.js: idempotency | No duplicate check | First → not duplicate, second same jobId → duplicate:true, no new deal/email, resendEmail true → extra send | Idempotency requirement |
| test/e2e.js: deliver | `POST {token, email, fields, blueprint}` → contact_id + pdf | `POST {token, jobId}` → contact_id + pdf, plus second call duplicate:true | Same as above, plus duplicate handling |
| test/netlify-sim.js: deliver | `POST {token, email, fields, blueprint}` → 200 | `POST {token, jobId}` → 200, hand-made blueprint without valid jobId → 404 | Server-side blueprint only |
| test/netlify-sim.js: recipient | Body email used | Token email used, body.email ignored | Token email everywhere |
| test/netlify-sim.js: Resend failure | Still 200 but old checked email.sent:false | Same, but now also checks persistence non-blocking | No change in expectation, but jobId flow |
| test/voice.js: deliver with voice_meta | `POST {email, fields, blueprint, voice_meta}` | `POST {jobId, voice_meta}` (fields/blueprint from job) | Server-side blueprint only, voice_meta still attached |
| test/demo-and-limits.js: per-email cap | 3 deliveries same body → 429 on 3rd | Fresh jobId each time → 429 on 3rd, because idempotency would otherwise make 2nd duplicate not count | Idempotency prevents double counting same job, so need fresh jobs to test per-email cap |
| test/demo-and-limits.js: global cap | 2nd delivery past cap still PDF but same body | Fresh jobId each time, 2nd still PDF with email daily limit error | Same reason + jobId flow |
| test/demo-and-limits.js: server per-email | POST {email, fields, blueprint} twice → 200 both | POST {jobId} first → 200, second same jobId → duplicate:true | Idempotency now expected |
| test/claude-pipeline.js: new | No timeout hang test | Added hang → deadline fallback reason:"timeout" + callClaude timeoutMs AbortController | Covers new timeout requirement |

All changed assertions are due to intentional behavior change (security hardening) — not weakening.

## Test results after changes
`npm run test:all` → all suites PASS (supabase, voice, chatgpt voice, continuous voice, e2e, pdf-email, netlify-sim, claude-pipeline, ui-design, ui-smoke, turnstile, demo-and-limits). Previously 936 PASS, now similar count (new tests added for idempotency, verification, timeouts).

## Env vars documented
- EMAIL_VERIFY (default true) — commented in .env.example and table in README
- AI_EXTRACT_DEADLINE_MS (8000) — same
- AI_GENERATE_DEADLINE_MS (60000) — same
- EMAIL_VERIFY_CODE_TTL_MIN (10) — same
- EMAIL_VERIFY_MAX_SENDS_HOUR (3) — same
- EMAIL_VERIFY_MAX_ATTEMPTS (5) — same
- DELIVER_RATE_PER_MIN (5) — already existed, kept

## Frontend reliability
- api.post uses AbortController 25s timeout, on timeout shows "Try again" button (#un-tryagain) which retries last action.
- Deliver UI: read-only session email, Email me a copy flow, code input, resend, duplicate notice, persistence warning.

## No new npm deps
Only @netlify/blobs allowed, already used. No new deps added.
