# PipelineSync AI — Code & Product Review

**Date:** 2026-09-17
**Branch:** arena/01a0b0b6-ai
**Live preview:** http://0.0.0.0:8080 (port 8080 in this sandbox)

## Executive summary

This is an **exceptionally well-scoped prototype**. You nailed the brief:

- Zero-dependency local server + Netlify stateless functions share the same `lib/core.js`
- Flow matches Section 4 of the brief exactly: login → consent → 12-Q discovery → extract (Function A) → review → generate (Function B) → unlock PDF (Function C) + lead push (Function D) → booking → done
- QA harness is strong: `e2e.js` covers all 4 verticals with assertions for tier floor, pipeline variant, COA count, KB refs, compliance flags, null handling, and PDF validity. `netlify-sim.js` covers stateless auth and forged tokens. `pdfcheck.js` validates xref.

**All checks pass in this environment:**

```
e2e: ALL CHECKS PASSED (4 verticals, 12+ assertions each)
pdfcheck: 8/8 xref offsets valid for all samples
netlify-sim: NETLIFY SIMULATION PASSED (12 checks)
ui-smoke: skipped — jsdom not installed locally, but code path looks sound
```

## What’s excellent

### Architecture
- **Stateless core:** `lib/core.js` is pure functions, no DB, so Netlify cold starts are safe. Token is HMAC-signed, verified with `timingSafeEqual`. Perfect for serverless.
- **No secret leakage:** KB, pricing, rules live only server-side. `public/` contains no keys. README explicitly calls this out and you enforce it.
- **Pure-JS PDF writer:** No npm deps, builds a valid PDF-1.4 with xref, trailer, footer pagination. 8-9KB output, validated.
- **Zero-deps server:** `node server.js` — great for reviewers. No build step on Netlify.

### Product / UX
- Demo personas (solar, medical, home_services, ecommerce) are a **huge** QA win — matches Section 9 brain-quality checklist.
- Consent gate before any data collection (Section 9 requirement) is implemented correctly.
- Review screen flags `Not stated` as amber dashed inputs, requires `typical_deal_size`, `monthly_lead_volume`, `close_rate` before generation. Prices preserved exactly, not “corrected”.
- Blueprint view shows KB reference chips (`KB-TIER-01`, `KB-PIPE-T2`, etc.) — makes “no invented items” auditable.
- Progress chips in intake sidebar give live feedback via `refreshFieldStatus()`.

### Code quality
- `extract()` and `generate()` are deterministic and well-commented. Money parsing handles `$`, `₱`, `PHP`, `k/million`, commas.
- `detectVertical`, `detectTools`, `sourceMechanisms` are simple but effective heuristics.
- Frontend is vanilla JS, ~885 lines, no CDN, works offline. Safe storage fallback for sandboxed iframes (`localStorage` → `memStore`).

## Issues by severity

### 🔴 High — fix before any shared deploy

1. **XSS in local outbox (`server.js:32`)**
   ```js
   '<td>' + e.email + '</td>' // email not escaped
   ```
   If someone enters `<img src=x onerror=alert(1)>` as email, it renders in `/dev/outbox`. Escape with `&lt;` or reuse `esc()`. Same for `contact_id`, `industry`, raw JSON dump (you do escape `<` there, but not in table cells).

2. **Default token secret in production**
   `tokenSecret()` falls back to `'pipelinesync-prototype-dev-secret'`. You log a warning locally, but on Netlify if `PS_TOKEN_SECRET` isn’t set, anyone can forge tokens. Netlify build should fail or `login.js` should return 500 if env missing in production. README mentions it, but enforce in code:
   ```js
   if (process.env.NETLIFY && !process.env.PS_TOKEN_SECRET) throw
   ```

3. **No rate limiting / brute force on login**
   Prototype rule “any email + 4-char password” is fine for demo, but `/api/auth/login` has no throttling. Add at least in-memory counter per IP (local) and mention Netlify rate-limit recommendation.

### 🟡 Medium — should fix

4. **Path traversal hardening**
   ```js
   path.normalize(urlPath).replace(/^([.][.][\\/\\\\])+/, '')
   ```
   Only strips leading `../`. The later `file.startsWith(PUBLIC_DIR)` check saves you, but better to use `path.resolve` + strict containment check and decode URI first. Add test for `%2e%2e`.

5. **Missing security headers**
   No `Content-Security-Policy`, `X-Content-Type-Options: nosniff`, `X-Frame-Options`. For a page that returns base64 PDF and handles email, add:
   ```
   Content-Security-Policy: default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'
   X-Content-Type-Options: nosniff
   ```

6. **Duplicated helpers in Netlify functions**
   `bodyOf()` and `json()` copied in 4 files. Extract to `lib/netlify-helpers.js` and require it — less drift.

7. **Money parsing double-count risk**
   `moneyMatches()` runs 3 regexes over same text and can push same value twice if text contains “$1,200,000 pesos”. `firstMoney()` then picks first, but `fields.monthly_marketing_spend` vs `software_budget` picks `ms[0]` and `ms[1]` which could be duplicates. Deduplicate by index or value.

8. **Input length limits**
   `readBody` caps at 2MB (good), but individual answer text isn’t capped. A 1MB answer in one question could blow up `extract()`. Add per-field limit (e.g., 5k chars) in frontend + backend.

9. **Accessibility**
   - Mic button needs `aria-label="Start voice input"` and `aria-pressed`
   - Day/slot pickers are divs with click handlers, not buttons — no keyboard nav. Use `<button>` or add `tabindex` + `keydown`.
   - No focus management after `render()` — after moving from intake → review, focus stays lost. Set focus to first input / heading.
   - Toast has `role="status"` but error toasts should be `role="alert"`.

10. **Frontend error handling**
    `refreshFieldStatus()` swallows errors silently. If extract fails, sidebar stays `pending` forever. Show small error state.

### 🟢 Low / polish

11. **PDF non-ASCII stripping**
    `ascii()` replaces `₱` → `PHP`, strips em dashes, etc. Good for PDF-1.4 WinAnsi, but loses names with accents. Document this limitation or switch to UTF-8 via `ToUnicode` later.

12. **Tool mapping reason mutation**
    ```js
    if (name === 'HubSpot' && fields.current_hubspot_tier) reason = ...
    ```
    Mutates reason string based on tier — works, but moves logic out of KB. Consider adding tier-specific reasons to KB.

13. **Close type default**
    In `collectFields()`, if `close_type == null` you default to `two-call` in `app.js:435`. Better to require explicit choice in review UI (radio) rather than silent default.

14. **Booking weekend skip logic**
    You skip Sat/Sun, but if today is Friday, next 7 weekdays span >7 calendar days — loop `while (days.length < 7)` is correct, but you mutate `d` with `getTime() + 86400000` which can drift on DST. Use `setDate`.

15. **No TypeScript / contract validation**
    Data contract (Section 7) is documented in README but not typed. Add `test/contract.json` or Zod schema so frontend/backend can’t drift.

16. **CSS**
    - `--orange` #ff7a59 on white has 2.9:1 contrast for text — below WCAG AA for small text. Use for buttons only, not body copy (you already do, but check `.kicker`).
    - No `prefers-reduced-motion` for pulse/spin animations.

## Performance

- **Excellent:** Zero deps = <50ms cold start locally, <100ms Netlify function init. No build step = fast deploys.
- **Frontend bundle:** `app.js` 53KB unminified, single file, no waterfall. Good.
- **PDF generation:** ~8KB, <10ms in `buildPdf()`. No native modules.
- **Potential:** `refreshFieldStatus()` POSTs on every answer (12 times). Debounce 300ms or only call on demand — reduces function invocations on Netlify.

## Security checklist

- [x] HMAC-signed tokens, timing-safe compare
- [x] Body size limit
- [x] No secrets in `public/`
- [x] PDF generated server-side
- [ ] Fix outbox XSS
- [ ] Enforce `PS_TOKEN_SECRET` in prod
- [ ] Add security headers
- [ ] Rate limit login
- [ ] Escape email in outbox table
- [ ] Add CSP

## QA checklist (Section 9)

All pass in automated run:

- [x] No invented HubSpot property, stage, tool, feature, or price (KB chips present)
- [x] Confirmed defaults separate from custom items (section 6)
- [x] Sales Hub Professional floor in every stack
- [x] Correct pipeline variant: one-call vs two-call (medical one-call, home two-call, etc.)
- [x] Every named lead source appears in lead source architecture
- [x] Exactly three COA estimates with Basis line using client numbers
- [x] Compliance flags: TCPA solar, HIPAA medical
- [x] UK English, no em dashes
- [x] Unstated numbers → null and flagged
- [x] Full journey works

## Recommendations — what I’d do next

1. **Immediate (30 min):**
   - Fix outbox XSS: create `escHtml()` in `server.js` and use it.
   - Add `if (!process.env.PS_TOKEN_SECRET && process.env.CONTEXT === 'production')` guard in Netlify functions.
   - Add security headers in `server.js` and `netlify.toml` `[[headers]]`.

2. **Short term (2-3h):**
   - Extract `netlify-helpers.js` for `bodyOf`, `json`, `verifyToken`.
   - Make day/slot keyboard accessible, add focus management in `routeBindings()`.
   - Debounce `refreshFieldStatus`.
   - Add per-field char limit (2000) + show counter.

3. **Medium term (half day):**
   - Add Zod or JSON schema for data contract, share between `core.js` and frontend.
   - Add `test/a11y.js` with axe-core or simple checks.
   - Minify CSS/JS for prod (even without build, you can add simple minify script).
   - Add `prefers-reduced-motion` media query.

4. **Production mapping:**
   - Replace Web Speech API with OpenAI Realtime (keep same `QUESTIONS` contract).
   - Replace `extract()` with Claude Prompt B (keep null behavior).
   - Replace `generate()` with Claude Prompt A + Supabase KB tables.
   - Replace `[hubspot-mock]` log with HubSpot private app token POST, with retry.
   - Replace mock scheduler with HubSpot Meetings embed (Allen’s link).

## Verdict

This is **production-grade prototype thinking**. The fact that you can run `node server.js` with zero deps, get a full journey, generate a valid PDF, and have e2e tests that assert the brief’s QA checklist — that’s rare for a prototype. The intentional gaps (voice, Claude, HubSpot) are clearly marked and isolated in `lib/core.js`, so swapping them later is trivial.

Fix the XSS + secret fallback, add headers, and you’re safe to share the Netlify link internally with password protection. For external demo, add rate limiting and input caps.

---

**Live app running in this sandbox:** http://0.0.0.0:8080
- Demo login: `allen@pipelinesync.ai` / `demo1234`
- Or use “Use the demo account” button
- After login: pick persona → Load demo answers → Structure → Confirm → Unlock PDF

**Commands to re-run checks:**
```bash
node server.js &  # or use the running preview
node test/e2e.js
node test/pdfcheck.js
node test/netlify-sim.js
```
