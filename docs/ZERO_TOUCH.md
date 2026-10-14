# Zero-touch: name + email → AI voice call → PDF

This is the operator guide for `AUTO_DELIVER`, the mode where the visitor never sees a form after
the call. It covers what they see, what the server does on their behalf, what is still enforced,
how to switch it off, and what to check when the PDF does not download. The PDF is only ever
downloaded in the web app; it is never emailed, in either mode.

The switch lives in one file — `lib/autopilot.js` — and is read from the environment as
`AUTO_DELIVER`. **Default: on.**

---

## 1. What the visitor experiences

```
1. entry gate            name + email                     (unchanged)
2. consent               one tick, the call starts        (the notice says the PDF downloads in the app)
3. the voice call        Nova speaks, listens, adapts     (unchanged - lib/voice.js)
4. "Structuring / Delivering"   real server progress      (no review screen, no unlock button)
5. the blueprint + the PDF      downloaded, CTA           (the delivered card, then book a call)
```

Step 5 is what changed. In the manual journey (`AUTO_DELIVER=false`) the blueprint appears straight
after the call, and the visitor ticks consent and clicks *Unlock official PDF* to download it. In
zero-touch the browser does all of that the moment the call ends: Function A (structure) →
Function B (Claude builds the blueprint) → Function C (server-side PDF, HubSpot, Supabase), then the
PDF downloads in the browser with no unlock click. The consent screen tells the visitor up front:
"When we finish, your blueprint PDF downloads right here in the app." There is no review screen in
either mode, and no "Email me a copy", code or resend control; the success card shows the PDF's file
name and the done screen reads "Your blueprint is ready to download".

The AI's closing line changes with the mode, because it would otherwise be a lie on the last thing
the caller hears:

| Mode | What Nova says happens next |
|---|---|
| `AUTO_DELIVER=false` (manual) | "…the blueprint is being built…, they can download it as a PDF on screen in a moment…" |
| `AUTO_DELIVER=true` (default) | "…the blueprint is being written… and will download as a PDF on screen in a moment…" |

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
| Deliver the PDF | `POST /api/deliver` `{jobId, consent:true, auto:true, consent_at}` | PDF built server-side from the stored job and returned for download in the app (never emailed), lead pushed to HubSpot/Supabase |

## 3. What `auto:true` does and does not do

`POST /api/deliver` with `"auto": true` is only honoured when `AUTO_DELIVER` is on. It does exactly
one extra thing: it carries the consent given on the consent screen, with its timestamp, so the CRM
note records when the visitor actually agreed.

It does **not** change:

- **the session** — a valid session token and a `jobId` are still required, and the PDF is built
  server-side from the stored job (or the server-signed `jobSeal`), never from a blueprint the
  browser sends;
- **consent** — `body.consent === true` is still required (400 without it), and the CRM note records
  the moment the visitor actually agreed (`consent_at`, carried from the consent screen) plus the
  source: `entry gate (zero-touch delivery)` vs `PDF unlock screen`;
- **the caps** — `DELIVER_RATE_PER_MIN` (5/min/IP), `DELIVER_PER_EMAIL_DAY` (3/day/email), and the
  voice session limits;
- **idempotency** — a repeat delivery returns the same PDF with `duplicate:true` and creates no new
  deal, so a reload or a retry cannot duplicate the lead.

Because the PDF only ever downloads in the visitor's own browser, nothing is sent to the address
typed at the gate. If a deployment wants an explicit click before the download, set
`AUTO_DELIVER=false` — the journey still works, it just has the consent tick and the unlock button
after the call.

## 4. Configuration

| Variable | Default | Meaning |
|---|---|---|
| `AUTO_DELIVER` | `true` | `true`/`1`/`yes`/`on` → zero-touch; `false`/`0`/`no`/`off` → manual journey. Anything else falls back to the default. |

The old email settings (`PDF_EMAIL_*`, `EMAIL_VERIFY*`) are ignored now that the PDF is
download-only, and can be deleted from the host.

`/api/config` reports the mode as `autoDeliver`, so the browser never guesses it. The dev server
also prints it at boot:

```
Zero-touch delivery: ON - after the call the blueprint is built and the PDF downloads in the app automatically, with no unlock click. Nothing is emailed.
```

and, with `AUTO_DELIVER=false`:

```
Zero-touch delivery: off (AUTO_DELIVER=false) - the blueprint shows after the call and the visitor clicks to unlock and download the PDF. Nothing is emailed.
```

## 5. When the PDF does not download

Nothing is hidden — the browser renders what the API reported:

| What the screen says | What happened | Fix |
|---|---|---|
| The success card with the PDF's file name | The PDF was built and downloaded | — |
| "The blueprint is ready, but the PDF could not be prepared automatically. …" | The deliver call itself failed (429 cap, network) | The blueprint stays on screen with the manual unlock button |
| "Built on: One thing Nova still needs" | The call ended without a required figure | Fill that one number; the journey continues automatically |

Server-side, every delivery writes the HubSpot result (`[hubspot] live push ok: …` or a
`[hubspot-mock] lead push: …` line), and the HubSpot note records
`PDF: downloaded by the lead in the web app (not emailed)`.

## 6. Tests

`npm run test:zero-touch` (`test/zero-touch.js`) proves:

1. the switch's parsing and the startup note;
2. the AI's closing lines in both modes, and that a missing required figure is still asked for;
3. `/api/config` reporting the mode;
4. the automatic delivery returns the PDF to download, and a repeat returns the same PDF;
5. consent still refused without it, and an unusable `consent_at` ignored rather than fatal;
6. `AUTO_DELIVER=false` still returning the PDF to download;
7. an end-to-end HTTP journey (gate → extract → generate → deliver) with a local email stub as a
   trap that is never reached, including the refusal to generate from a missing figure;
8. the browser journey in jsdom: gate → consent → the whole call → delivered blueprint, asserting the
   review form never appeared.

The rest of the suite pins `AUTO_DELIVER=false` (`test/harness.js`) so the manual journey keeps being
tested exactly as it was.
