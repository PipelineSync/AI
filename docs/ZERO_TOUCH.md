# Zero-touch: name + email → AI voice call → PDF

This is the operator guide for `AUTO_DELIVER`, the mode where the visitor never sees a form after
the call. It covers what they see, what the server does on their behalf, what is still enforced,
how to switch it off, and what to check when a delivery does not arrive.

The switch lives in one file — `lib/autopilot.js` — and is read from the environment as
`AUTO_DELIVER`. **Default: on.**

---

## 1. What the visitor experiences

```
1. entry gate            name + email                     (unchanged)
2. consent               one tick, the call starts        (the notice now says the PDF is emailed)
3. the voice call        Nova speaks, listens, adapts     (unchanged - lib/voice.js)
4. "Structuring / Delivering"   real server progress      (no review screen, no unlock button)
5. the blueprint + the PDF      emailed, downloaded, CTA  (the delivered card, then book a call)
```

Step 5 is what changed. In the manual journey the visitor had to review every field, confirm, then
find *Unlock & email PDF* and tick a second consent box. In zero-touch the browser does all of that
the moment the call ends: Function A (structure) → Function B (Claude builds the blueprint) →
Function C (server-side PDF, email, HubSpot), then the PDF is downloaded in the browser and the
screen shows exactly what the API reported about the email.

The AI's closing line changes with the mode, because it would otherwise be a lie on the last thing
the caller hears:

| Mode | What Nova says happens next |
|---|---|
| `AUTO_DELIVER=false` (manual) | "…you can review and correct what was captured, then the blueprint is built…" |
| `AUTO_DELIVER=true` (default) | "…the blueprint is being written and will reach your inbox as a PDF in the next few minutes…" |

That clause comes from one place (`closeNextClause()` in `lib/voice.js`) and is used by the
step-by-step prompt, the continuous (Realtime) closing instructions, the over-time/idle closes, and
the spoken answer to *"What happens after the call?"*. The browser mirrors it for the idle and
session-limit nudges it sends to the model (`closeNextSpoken()` in `public/app.js`).

## 2. What runs on the visitor's behalf

| Step | Where | Notes |
|---|---|---|
| Structure the answers | `POST /api/extract` | Function A; Claude when `ANTHROPIC_API_KEY` is set |
| **Required figures missing?** | `public/app.js` → `autoNeedsView()` | One short card asking for **only** the missing figures (typical deal size, monthly lead volume, close rate, close type). Never the whole form, never a guess. |
| Build the blueprint | `POST /api/generate` + job polling | Function B; the same background job and progress states as the manual flow |
| Deliver the PDF | `POST /api/deliver` `{consent:true, auto:true, consent_at}` | PDF built server-side, emailed to the **token** address, pushed to HubSpot/Supabase |

The escape hatch stays available: the delivered screen and the short card both link to the full
review form, where every field can still be corrected and the blueprint rebuilt.

## 3. What `auto:true` does and does not do

`POST /api/deliver` with `"auto": true` is only honoured when `AUTO_DELIVER` is on. It does exactly
one extra thing: it treats the **first** delivery as verified without the emailed 6-digit code.

It does **not** change:

- **the recipient** — always the email inside the signed session token, never one typed on a page;
- **consent** — `body.consent === true` is still required (400 without it), and the CRM note records
  the moment the visitor actually agreed (`consent_at`, carried from the consent screen) plus the
  source: `entry gate (zero-touch delivery)` vs `PDF unlock screen`;
- **the caps** — `DELIVER_RATE_PER_MIN` (5/min/IP), `DELIVER_PER_EMAIL_DAY` (3/day/email),
  `PDF_EMAIL_DAILY_MAX` (80/day global), and the voice session limits;
- **idempotency** — a repeat delivery returns the same PDF with `duplicate:true` and sends no second
  email, so a reload or a retry cannot spam the visitor;
- **the review path** — with `AUTO_DELIVER=false` the code step and the manual flow are exactly what
  they were, and the manual "email me a copy" path still needs the code while `EMAIL_VERIFY` is on.

The trade-off, stated plainly: without the code, someone could type a stranger's address at the gate
and have one PDF emailed to it. The address is fixed by the session token, delivery is capped per
address and globally, and the manual path still verifies. If that trade is not acceptable for a
deployment, set `AUTO_DELIVER=false` — the journey still works, it just has the review and unlock
screens in it.

## 4. Configuration

| Variable | Default | Meaning |
|---|---|---|
| `AUTO_DELIVER` | `true` | `true`/`1`/`yes`/`on` → zero-touch; `false`/`0`/`no`/`off` → manual journey. Anything else falls back to the default. |
| `EMAIL_VERIFY` | `true` | Still controls the code step for manual sends and resends. Zero-touch skips it for the first automatic send only. |
| `PDF_EMAIL_API_KEY` / `PDF_EMAIL_FROM` | — | Without these the blueprint is still built and downloaded; the screen says the email was not sent, and the HubSpot note records the same. |
| `PDF_EMAIL_ENDPOINT` | Resend | Optional http(s) endpoint for a Resend-compatible proxy or a local test stub. |

`/api/config` reports the mode as `autoDeliver`, so the browser never guesses it. The dev server
also prints it at boot:

```
Zero-touch delivery: ON - after the call the blueprint is built and the PDF is emailed automatically
to the address from the entry gate. EMAIL_VERIFY is also on, so only the first automatic delivery
skips the code; set AUTO_DELIVER=false for the manual review + code flow.
```

## 5. When a delivery does not arrive

Nothing is hidden — the browser renders what the API reported:

| What the screen says | What happened | Fix |
|---|---|---|
| "Emailed: Sent to …" | Resend accepted it | — |
| "Emailed: Couldn't email it — download below" + reason | `PDF_EMAIL_API_KEY` unset, domain not verified, daily cap, etc. | Set the key/domain, or raise `PDF_EMAIL_DAILY_MAX` |
| "…could not send it automatically (…)" | The deliver call itself failed (429 cap, network) | The blueprint stays on screen with the manual unlock button |
| "Built on: One thing Nova still needs" | The call ended without a required figure | Fill that one number; the journey continues automatically |

Server-side, every delivery writes a line: `[email] blueprint sent to … (resend id …)`,
`[email] blueprint NOT sent to …: <reason>`, `[deliver] zero-touch delivery (AUTO_DELIVER=true): first
send to the session email without an email code`, and the HubSpot note records the email result.

## 6. Tests

`npm run test:zero-touch` (`test/zero-touch.js`) proves, without a Resend account:

1. the switch's parsing and the startup note;
2. the AI's closing lines in both modes, and that a missing required figure is still asked for;
3. `/api/config` reporting the mode;
4. the automatic first send **with `EMAIL_VERIFY=true` and no code**, and that a repeat sends nothing;
5. consent still refused without it, and an unusable `consent_at` ignored rather than fatal;
6. `AUTO_DELIVER=false` restoring the code step;
7. an end-to-end HTTP journey whose email really reaches a local Resend stub
   (`PDF_EMAIL_ENDPOINT`), including the refusal to generate from a missing figure;
8. the browser journey in jsdom: gate → consent → the whole call → delivered blueprint, asserting the
   review form never appeared.

The rest of the suite pins `AUTO_DELIVER=false` (`test/harness.js`) so the manual journey keeps being
tested exactly as it was.
