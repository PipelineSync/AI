# Fixes Applied — Post Review Hardening

**Date:** 2026-09-17
**Base:** REVIEW.md findings

All automated tests still pass after fixes:
- e2e: ALL CHECKS PASSED
- netlify-sim: NETLIFY SIMULATION PASSED
- pdfcheck: PDF STRUCTURE OK

## 🔴 High severity — FIXED

### 1. XSS in local outbox (`server.js:32`)
**Before:** `'<td>' + e.email + '</td>'` — raw email inserted into HTML
**After:**
- Added `escHtml()` that escapes `&<>"'`
- All outbox fields now escaped: `escHtml(e.email)`, `escHtml(e.contact_id)`, etc.
- Raw JSON dump also escaped via `escHtml(JSON.stringify(...))`
- Email regex already blocks `< >`, but defense-in-depth added.

### 2. Default token secret in production
**Before:** `process.env.PS_TOKEN_SECRET || 'dev-secret'` — silent fallback
**After:**
- `tokenSecret()` now throws if `CONTEXT=production` or `NETLIFY=true` or `NODE_ENV=production` and secret missing
- Logs warning if secret <16 chars
- `login.js` and `deliver.js` catch throw and return 500 with "Server misconfigured: missing token secret"
- Local dev still allows dev secret with warning, as intended.

### 3. No rate limiting on login
**Before:** Unlimited login attempts
**After:**
- `server.js`: in-memory `rateLimitMap` per IP, 20 req/min for login, returns 429 with Retry-After
- `lib/netlify-helpers.js`: same limiter for Netlify functions (per lambda instance)
- Cleanup interval every 5 min to prevent memory leak

## 🟡 Medium — FIXED

### 4. Path traversal hardening
**Before:** `path.normalize(urlPath).replace(/^([.][.][\\/\\\\])+/, '')` only stripped leading `../`, relied on `startsWith`
**After:**
- `decodeURIComponent` with try/catch
- Null byte check
- `path.resolve(PUBLIC_DIR, '.' + path.normalize(relativePath))` and strict containment: `startsWith(PUBLIC_DIR + sep)`
- `fs.stat` check that target is file, not directory
- Returns 403 for traversal attempts

### 5. Missing security headers
**Before:** No CSP, X-Frame-Options, etc.
**After:**
- `securityHeaders()` in `server.js` returns:
  - `X-Content-Type-Options: nosniff`
  - `X-Frame-Options: DENY`
  - `Referrer-Policy: strict-origin-when-cross-origin`
  - `Permissions-Policy: microphone=(self), camera=()`
  - `Content-Security-Policy: default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; connect-src 'self'; font-src 'self'; object-src 'none'; base-uri 'self'; frame-ancestors 'none'`
- Added to all JSON and static responses
- Added `[[headers]]` in `netlify.toml` for deployed site
- `lib/netlify-helpers.js` and `outbox.js` also return hardened headers

### 6. Duplicated helpers in Netlify functions
**Before:** `bodyOf()` and `json()` copied in 4 files
**After:**
- Created `lib/netlify-helpers.js` with `bodyOf`, `json`, `securityHeaders`, `checkRateLimit`, `getClientIp`, `validateAnswers`
- All functions now `require('../../lib/netlify-helpers')`
- Single source of truth, includes body size limit (2MB) and security headers

### 7. Money parsing double-count
**Before:** 3 regexes could push same value twice, `re3` dedup checked `o.raw === m[1]` (wrong)
**After:**
- `seenRaw` Set for raw string dedup (lowercased)
- `seenPos` array tracks [start,end] to prevent overlapping matches
- `addMatch()` checks both before pushing
- Now `moneyMatches()` returns unique, non-overlapping values

### 8. Input length limits
**Before:** Only 2MB body cap, per-field unlimited
**After:**
- `server.js` and `netlify-helpers.js` `validateAnswers()`:
  - Max 20 answers
  - Each `id` max 100 chars, `text` max 5000 chars
  - Email max 254, password max 128
  - Fields payload max 100k JSON
- Frontend: `MAX_CHARS=5000`, textarea `maxlength`, char counter, toast if too long

### 9. Accessibility
**Before:** Mic button no aria, day/slot divs not keyboard accessible, no focus management
**After:**
- Mic button: `aria-label`, `aria-pressed` toggled in `updateMicUI()`
- Day/slot: changed from `div` to `button`, added `aria-pressed`, `aria-label`, `aria-disabled`, keyboard handlers for Enter/Space
- Added `role="progressbar"`, `aria-valuenow`, `role="log"`, `aria-live="polite"`, `role="status"/"alert"` for toasts and success cards
- Focus management:
  - Login: focus email
  - Consent: focus checkbox
  - Intake: focus textarea, char counter live
  - Review: focus first empty required field, focus last added row
  - Blueprint: focus main content
  - Booking: focus first day, keyboard nav
  - Done: focus primary button
- Added `tabindex="-1"` and focus styles for main content
- Buttons have `focus-visible` outline

### 10. Frontend error handling
**Before:** `refreshFieldStatus()` swallowed errors, sidebar stuck pending
**After:**
- Debounced (400ms) to reduce function invocations
- On error, sets `state.fieldError` and shows alert in sidebar with `role="alert"`
- Toast uses `role="alert"` for errors, `role="status"` for info

## 🟢 Low / polish — FIXED

### 11. Booking DST bug
**Before:** `new Date(d.getTime() + 86400000)` — drifts on DST
**After:** `cursor.setDate(cursor.getDate() + 1)` with `setHours(0,0,0,0)` reset — DST-safe

### 12. Close type silent default
**Before:** `if (f.close_type == null) f.close_type = 'two-call'` — silent
**After:** Review now requires explicit selection:
- Shows "Please select how you close - this affects pipeline stages" when null
- `check()` blocks generate if `close_type == null`
- Toast "Please select Close type before generating"

### 13. CSS contrast & motion
**Before:** `--orange-dark: #e85c3a` (2.9:1 on white), `--amber: #b45309`, animations always on
**After:**
- `--orange-dark: #d94a28` (darker, better contrast)
- `--amber: #92400e`, `--red: #b91c1c`
- Added `@media (prefers-reduced-motion: reduce)` to disable pulse/spin
- Added `focus-visible` styles for buttons, icon-btn, day/slot
- Added `.char-counter` style

### 14. PDF non-ASCII (documented)
Kept `ascii()` stripping but noted in code comments — acceptable for prototype PDF-1.4 WinAnsi. Future: ToUnicode.

## Files changed
- `server.js` — hardened
- `lib/core.js` — moneyMatches dedup + token secret enforcement
- `lib/netlify-helpers.js` — NEW shared helpers
- `netlify/functions/*.js` — all refactored to use helpers, security headers, validation
- `netlify.toml` — added security headers
- `public/app.js` — a11y, debounce, DST fix, explicit close_type, focus mgmt
- `public/styles.css` — contrast, focus, reduced-motion

## Verification
```bash
node server.js &
node test/e2e.js        # ALL CHECKS PASSED
node test/netlify-sim.js # NETLIFY SIMULATION PASSED
node test/pdfcheck.js   # PDF STRUCTURE OK
curl -i http://127.0.0.1:8080/api/health # shows security headers
```

Live preview still works on port 8080.

---

## Merge note: voice layer compliance (2026-09-18)

The voice discovery call was built on the pre-hardening base and merged with these fixes. Three
interactions were found and resolved, so the hardening holds and the voice still works:

1. **CSP blocked the voice audio.** `default-src 'self'` leaves `media-src` at `'self'`, and the AI
   speech is played from a `blob:` (or `data:`) URL, so the browser refused to play it. Added
   `media-src 'self' blob: data:` in `netlify.toml` and `lib/netlify-helpers.js`.
2. **Framing headers broke the preview pane.** `X-Frame-Options: DENY` + `frame-ancestors 'none'`
   stop the local server being embedded in the preview. Production keeps both; the local dev server
   now sends `frame-ancestors *` and no `X-Frame-Options`, with `PS_ALLOW_FRAMING=0` to restore the
   strict rule. Note this is deliberately dev-only: never relax it on the deployed site.
3. **The new voice endpoints were unprotected.** `/api/voice/*` now reuses the same hardening
   helpers (`lib/netlify-helpers.js`) and adds per-IP rate limits (`VOICE_RATE_PER_MIN`, default 40
   turns/minute locally) plus payload bounds (`validateTurnBody`: answers, transcript, captures,
   last answer) so a stranger cannot run up OpenAI spend.
4. **Escaping in the dev outbox** now applies to the `voice_call` block too, and the UI smoke test
   asserts the escaping rather than the raw JSON.

All suites pass after the merge: voice, voice-openai (mock ChatGPT path), ui-smoke (voice-first and
typed fallback), e2e, netlify-sim, pdfcheck.

---

## Audit against the brief's own QA checklist (2026-09-18)

Audited the app line by line against the brief's Section 9 checklist (Section 4 flow, Section 6
intake set, Section 7 contract). Most items were already covered, but two gaps were real, and the
checks that were missing are now automated in `test/brief-check.js` (136 assertions, all four
verticals, HTTP and Netlify paths).

### 1. The three required figures were only enforced in the browser — FIXED

**Before:** the review screen disabled the generate button while deal size, monthly lead volume or
close rate were null, but `POST /api/generate` accepted the request and returned 200. Called
directly, it produced a blueprint whose cost-of-inaction bases read literally
`null leads in, null closed, 0 slipping each month`, which breaks the rule that the blueprint is
grounded in the client's own numbers.

**After:** `missingRequiredFields()` in `lib/core.js` is the single source of the rule. Both
`server.js` and `netlify/functions/generate.js` answer **422** with the missing field names, and the
voice layer now imports the same list instead of keeping its own copy.

### 2. Two KB reference ids were inline strings — FIXED

`KB-PRISE-01` (pricing) and `KB-BUILD-01` (the build list) were `ref.add('...')` literals, so the
"no invented items" check could not be verified mechanically. Both are now declared in the
knowledge base, every catalogue tool carries its own `id`, and `kbReferenceIds()` walks the KB so a
test can prove every reference in a blueprint resolves to a declared entry. A tool the client names
that is not in the catalogue now gets no KB reference at all, rather than one pointing at nothing.

### 3. Duplicated sentence in client-facing copy — FIXED

The HubSpot reason read "You are on Starter. You are on the entry tier. This build needs
workflows...". The generic opener is now dropped when the client's own tier is known.

### What `test/brief-check.js` adds on top of the existing suites

- every `kbReferences` entry resolves to an id declared in the KB (the old check only counted them)
- every tool action and reason is the KB wording, every pipeline stage list is the KB list
- every confirmed default is a KB default, and no item sits in both the defaults and custom lists
- every named lead source appears by name, with a KB mechanism; none invented or duplicated
- exactly three cost-of-inaction estimates, each Basis line built from the client's own figures and
  free of nulls, printed three times in the PDF
- compliance flags per vertical (TCPA solar, HIPAA medical, none for the other two)
- UK English and no em/en dashes in the blueprint and in the drawn PDF text
- the required figures block generation on the API and on the Netlify function; one figure filled in
  still blocks and names the other two
- the 12-question intake set covers all three required figures, and every contract field the
  extractor produces has a sidebar label
- no API key material, secret variable names, KB wording, or KB reference ids in `public/`

All eight suites pass: voice, voice-openai, e2e, netlify-sim, pdfcheck, brief-check, ui-design,
ui-smoke (421 assertions).

---

## Spoken figures were silently read as "Not stated" (2026-09-18)

Found while checking Function A against the brief: the discovery call is **voice**, so answers arrive
as words, but the extractor only read digits. All three required figures failed on the phrasing a
client actually says out loud:

| The client says | Before | After |
|---|---|---|
| "a typical deal is about one and a half million" | `null` | 1500000 |
| "most jobs are around eighty thousand each" | `null` | 80000 |
| "about fifty five leads a month" | `null` | 55 |
| "we close around thirty percent" | `null` | 30 |
| "about fifty thousand a month on marketing" | `null` | 50000 |
| "₱80,000 per job" | `null` | 80000 |

A false null is worse than a missing one: the review screen reports it as "Not stated", so a figure
the client did give looks like one they never gave, and the Marketing Hub rule (spend at or above
50,000 a month) silently under-recommends the stack. The peso symbol was also absent from the
currency class, which had `₴` (hryvnia) where this product is peso-based.

**Fix, all in `lib/core.js`:**

- `WORDS` completed (sixteen to nineteen, seventy, ninety) and a real phrase parser added:
  `parseNumberPhrase()` reads "fifty five", "two hundred", "two hundred thousand", "one and a half
  million", and digits alike. `numberByUnit()` / `numberAfterUnit()` bind a phrase to its unit in
  either word order.
- The parser stops at "and" once a scaled unit has been applied. Without that, "one and a half
  million **and three reps** take calls" ran on into the next clause, which both corrupted the value
  and dragged a count noun into the money match, vetoing it entirely.
- `moneyMatches()` gained a spoken-money pass (an explicit multiplier is required, and a following
  count noun vetoes it, so "two thousand installs" is never money) and now recognises `₱` and `£`.
  Matches carry their position.
- `spendFigures()` assigns each figure to the keyword it sits nearest, so in "fifty thousand a month
  on marketing and five thousand on software" the software figure cannot be taken for the marketing
  spend just because it happens to sit closer to the word "marketing".
- Nothing is invented: with no number phrase present every field still returns `null`.

`test/brief-check.js` gained 19 assertions covering the spoken forms, the reversed word order, the
peso symbol, the not-money veto, the null cases, and the digit forms the personas rely on.

All eight suites pass: 440 assertions.
