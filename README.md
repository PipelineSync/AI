# PipelineSync AI - Prototype Build

Runnable prototype of the app described in `PipelineSync_AI_Developer_Brief.pdf`. Built to be
tested end to end in the browser. External services are simulated and clearly marked, so nothing
blocks on credentials - with one exception that matters: **the discovery call voice layer is real.**
ChatGPT words each turn, OpenAI speaks it, and the answers are captured against the Section 7 data
contract. See `docs/VOICE_SETUP.md` for the one environment variable that switches it on.

Two ways to run it:

- **Local:** `node server.js` (zero dependencies, http://0.0.0.0:8080)
- **Deployed:** GitHub repo → Netlify (stateless functions, no Supabase needed) - see below.

## Deploy to Netlify from GitHub (no Supabase)

The app is already Netlify-ready: static files in `public/`, API in `netlify/functions/`,
routing in `netlify.toml`. No build step is needed.

### 1. Push the code to GitHub

```bash
cd pipelinesync
git init
git add .
git commit -m "PipelineSync AI prototype: Netlify-ready (no Supabase)"
# create an empty repo on github.com first (e.g. pipelinesync-ai), then:
git branch -M main
git remote add origin https://github.com/<you>/pipelinesync-ai.git
git push -u origin main
```

### 2. Import the repo into Netlify

1. Log in to [netlify.com](https://app.netlify.com) with your GitHub account.
2. **Add new site** → **Import an existing project** → choose **GitHub**.
3. Authorise Netlify if prompted, then select the `pipelinesync-ai` repo.
4. Netlify reads `netlify.toml` automatically. Confirm the settings:
   - **Build command:** (leave empty - there is no build step)
   - **Publish directory:** `public`
5. **Deploy site.** The first deploy takes about a minute.

### 3. Environment variables (optional but recommended)

Site configuration → **Environment variables** → **Add a variable**:

| Variable | Value | Why |
|---|---|---|
| `PS_TOKEN_SECRET` | any long random string, e.g. the output of `openssl rand -hex 16` | Signs the entry-gate session tokens and the voice call tickets. Without it a built-in dev secret is used (fine for a throwaway test deploy, not for anything shared). |
| `OPENAI_API_KEY` | your OpenAI key (`sk-...`) | **Switches the discovery call on to ChatGPT voice**: wording, speech out, and transcription in. Read inside the functions only, never sent to the browser. Without it the call runs on the built-in interviewer and the browser voice, so the demo still works. |

Optional voice settings (`VOICE_PROVIDER`, `OPENAI_CHAT_MODEL`, `OPENAI_TTS_MODEL`,
`OPENAI_TTS_VOICE`, `OPENAI_STT_MODEL`, `VOICE_STT`, `VOICE_LANGUAGE`, `VOICE_LOCALE`,
`VOICE_MAX_TURNS`, `OPENAI_BASE_URL`) and everything else about the voice layer is documented in
`docs/VOICE_SETUP.md`.

Later, when the remaining keys arrive, add them here too (they only reach the functions, never the
browser): `ANTHROPIC_API_KEY`, `SUPABASE_URL`, `SUPABASE_SERVICE_KEY`, `HUBSPOT_ACCESS_TOKEN`,
`SCHEDULER_LINK`.

### 4. Test the deployment

Open your `https://<site>.netlify.app` URL:

1. **Use the demo account** → tick consent → pick a persona in the intake sidebar
   (solar, medical, home services, e-commerce) → *Load demo answers* → *Structure my answers*.
2. Review, *Confirm and generate blueprint*, then *Unlock the PDF* - the PDF downloads
   (it is generated server-side inside the `deliver` function).
3. **Find the lead:** Netlify dashboard → site → **Functions** → `deliver` → **Logs**.
   Each push appears as a line starting `[hubspot-mock] lead push:` with the full payload
   (email, all answers, blueprint reference). The `/dev/outbox` page on the site explains this too.
4. Book a call, finish, run a second business. Every `git push` to `main` auto-redeploys.

### Important notes for the test deploy

- **There is no login**: the app opens on a name + email gate and hands back a signed session
  token, so anyone with the link can start a call and create a lead. Treat the deployment as an
  internal test link. To lock it down, add Netlify **Password protection** (Site configuration →
  Domain management → Password protection - free, per domain), or switch on Supabase Auth
  (magic link or OTP on the same two fields - the API shape does not change).
- **Do not collect real business data** in this deployment: without Supabase there is no
  persistent store, and the lead payloads live only in the function logs.
- Serverless means **no shared memory**: sessions are HMAC-signed tokens (stateless), the
  blueprint travels with the request, and the PDF is returned to the browser as base64. That is
  why the app works across cold starts with zero database.

## The journey (matches Section 4 of the brief)

1. **Enter your name and email** - the entry gate, no password. The name is what the AI calls the
   client on the call and what lands on the HubSpot lead; the email is where the PDF is delivered.
   In production the same two fields go through Supabase Auth (magic link or OTP).
2. **Disclaimer + privacy notice** - shown and accepted before any data is collected (Section 9).
3. **Discovery call (voice, not chat)** - agreeing to the disclaimer is what starts the call: the AI
   speaks the first question immediately (the opening line is prefetched while the notice is being
   read, so the voice starts inside that click, not after a round trip). There is no second start
   button and no text box, and with a blocked microphone the typed fallback appears by itself.
   It asks the 12-question intake set out loud, one question per turn, waits while the client talks,
   and probes once when an answer arrives without its figures. The transcript stays collapsed behind
   a link: the call is spoken. Typing lives behind *Type instead* (and turns on automatically if the
   browser blocks the microphone), and anything the client does not know can be skipped.
   With `OPENAI_API_KEY` set, ChatGPT words and speaks every turn (`docs/VOICE_SETUP.md`); without
   it the same guardrail set drives the call through the built-in interviewer and the browser voice.
   QA shortcut: load one of the four demo personas (solar, medical, home services, e-commerce) -
   these are the four verticals in the brain-quality checklist - which fills the same 12 answers
   without needing a microphone.
4. **Structure the answers** (Function A, mock of Claude + Prompt B) - transcript answers are mapped
   to the Section 7 data contract. Unstated values come back as `null`; prices and tool names are
   preserved exactly, not corrected.
5. **Review and correct** - every field is editable on screen. `Not stated` items are flagged amber;
   typical deal size, monthly lead volume, and close rate are required so the blueprint can be
   grounded in the client's own numbers.
6. **Generate the blueprint** (Function B, mock of Claude + Prompt A) - built strictly from the
   knowledge base v1 (server-side). Every KB item used is tagged with an id (see the chips at the
   bottom of the blueprint) so the "no invented items" QA check is auditable.
7. **Unlock the PDF** (Function C, real server-side PDF) - gated behind email. A genuine PDF file is
   generated by a pure-JS PDF writer in `lib/core.js` (no npm packages), inside the function.
8. **Lead captured** (Function D, mock of the HubSpot private-app-token push) - a lead with all
   answers and a blueprint reference is logged as `[hubspot-mock] lead push: ...`.
9. **Book a call** - mock of the embedded HubSpot Meetings scheduler (the real embed uses Allen's
   scheduler link in production).

## UI and responsive design

One stylesheet (`public/styles.css`), no framework and no CDN, so the app still works offline in a
sandboxed preview. It is written **mobile-first**: the base rules are the phone layout and each
`@media (min-width: ...)` block adds the wider layout on top, so a narrow viewport is never a
scaled-down desktop.

| Width | Layout |
|---|---|
| < 680px (base) | single column, 44px touch targets, step pills show numbers only (the active one keeps its label), the entry gate stacks, button rows stack full width, wide tables scroll sideways inside their card, the call controls pin to the bottom of the card so they stay above the keyboard, and the captured-answers panel is a drawer opened from the call header |
| 680px | two-column review grid and unlock form, button rows go horizontal, the header shows the name and email chip, the booking day strip fills seven across, the blueprint stat tiles go four-up |
| 900px | the discovery call becomes call plus a sticky sidebar rail and the drawer toggle disappears, the entry gate becomes a split hero, the blueprint document gets full padding |
| 1140px | the blueprint document opens up to a wider measure |

Design rules that `node test/ui-design.js` enforces:

- **Colour is the brand mark** - navy `#0F2F52`, steel `#3E6C8E`, orange `#F57C1F`, taken from
  `public/logo.svg`. Orange is an accent, never a text background: white on `#F57C1F` is 2.7:1, so
  primary buttons are navy (13.6:1) and brand-coloured text uses `--brand-ink` (5.8:1). The check
  reads every token back out of the stylesheet and asserts the pairs against WCAG AA (4.5:1, or 3:1
  for large marks), so a redesign that drops a contrast ratio fails the build.
- **Fluid type**: headings use `clamp()`, so one markup scales from a 320px phone to a wide monitor.
- **Touch first**: `--tap` is the 44px floor for every button, input, day and slot; the call controls
  are sticky above the on-screen keyboard on phones, and the layout honours
  `env(safe-area-inset-bottom)` for the iOS home indicator.
- **Nothing is trapped behind a breakpoint**: wide tables scroll in `.tbl-wrap` instead of squashing,
  the step rail scrolls horizontally with snap, and the sidebar is a drawer on phones rather than
  being hidden. The check also asserts that every class `public/app.js` renders still has a rule, so
  a restyle cannot silently drop a style the UI depends on.
- **Preferences respected**: `prefers-reduced-motion` stops the orb pulse and the spinners,
  `forced-colors` mode gets real borders, and the print stylesheet prints just the blueprint.
- **The logo always sits on a light plate.** The mark is navy `#0F2F52` and steel `#3E6C8E`, so on
  the navy entry-gate hero an un-plated mark measures **1.00:1** (navy) and **2.42:1** (steel) and
  disappears. `logoTile()` in `public/app.js` wraps every mark in `.logo-plate` (white, 13.56:1
  against the hero) except the one inside the call orb, which passes a mono colour because the orb is
  its own background. `node test/ui-design.js` asserts this, so a new `logoMark()` call cannot
  reintroduce it. For decks and slides, use `public/logo-on-dark.svg`.
- **Accessibility is in the markup, not bolted on**: skip link, `aria-current="step"` on the rail,
  `aria-live` on the AI line and the call status, `aria-expanded` on both drawers, and visible
  `:focus-visible` rings throughout.

## Local vs deployed mapping

| Concern | Local (`node server.js`) | Netlify (GitHub deploy) |
|---|---|---|
| Auth | signed token (stateless) | signed token (stateless, same code) |
| Functions A-D | routes in `server.js` | `netlify/functions/{extract,generate,deliver,...}.js` |
| Voice routes (`/api/voice/*`) | `lib/voice-api.js` mounted by `server.js` | `netlify/functions/voice.js` (same handler) |
| Lead outbox | in-memory, view at `/dev/outbox` | function logs (see `/dev/outbox` page) |
| Shared core | `lib/core.js` | `lib/core.js` (bundled into each function) |

| Prototype (this repo) | Production (per the brief) |
|---|---|
| Signed tokens from a name + email gate (`/api/auth/start`) | Supabase Auth: magic link or OTP on the same name + email fields |
| Voice discovery call (`lib/voice.js` + voice engine in `app.js`) | The same code, with `OPENAI_API_KEY` set: ChatGPT words the turns, OpenAI speaks them, OpenAI transcribes. Realtime (WebRTC) voice is the next step if wanted |
| `extract` (deterministic parser in `lib/core.js`) | Function A: Claude + Prompt B |
| `generate` (KB-driven logic) | Function B: Claude + Prompt A |
| `deliver` (pure-JS PDF writer) | Function C: server-side PDF generator |
| `[hubspot-mock]` log line in `deliver` | Function D: HubSpot private app token push |
| `KB` object in `lib/core.js` | Supabase tables: rules, tools, prices, vertical recipes, intake set |
| Mock scheduler panel in `app.js` | Embedded HubSpot Meetings scheduler |
| Vanilla JS SPA in `public/` | React on Netlify (same flow and contract) |

**Security rule honoured:** every key and the entire knowledge base live server-side. Nothing in
`public/` contains secrets or the KB; the browser only ever sees rendered output.

## Knowledge base v1 (server-side)

- **Tier logic:** Sales Hub Professional is the floor (the build needs workflows, Starter cannot
  run them). Enterprise review when 4+ reps, 12+ week cycle, or 500+ leads/month. Marketing Hub
  Professional at 50k+/month spend or 300+ leads/month. Service Hub where the vertical recipe says
  so (medical).
- **Pipeline variants:** one-call (6 stages) vs two-call (8 stages), chosen from `close_type`.
- **Lead source mechanisms:** per-source HubSpot mechanism (web forms + UTM, connected ad account,
  social landing forms, referral links, mobile quick-capture, email import).
- **Tool catalogue:** ~18 known tools with keep / replace / consolidate / upgrade guidance.
- **Vertical recipes:** solar, medical, home services, e-commerce (plus a generic fallback), each
  with workflows and compliance flags (TCPA for solar outbound, HIPAA + DPA 2012 for medical).
- **Cost of inaction:** exactly three estimates, each computed from the client's own numbers with
  the formula shown in the "Basis" line.

## QA (Section 9 of the brief)

Run each demo persona from the intake sidebar, then check the blueprint:

- [ ] No invented HubSpot property, stage, tool, feature, or price (compare against KB chips)
- [ ] Confirmed defaults kept separate from custom items (section 6)
- [ ] Sales Hub Professional floor in every stack (section 2)
- [ ] Correct pipeline variant for one-call vs two-call (section 3)
- [ ] Every named lead source appears in the lead source architecture (section 4)
- [ ] Exactly three cost-of-inaction estimates, each with a "Basis" line using the client's numbers
- [ ] Compliance flags: TCPA on the solar persona, HIPAA on the medical persona
- [ ] UK English, no em dashes
- [ ] Function A: unstated numbers come back as null and are flagged on the review screen
- [ ] Full journey works: name + email gate, voice, review, submit, PDF, lead, booking
- [ ] Agreeing to the disclaimer starts the call: the AI speaks first, there is no second start
      button and no text box
- [ ] Every one of the 12 questions is asked out loud exactly once, in order, with a probe only when
      an answer arrived without its figures
- [ ] The three required fields (deal size, monthly lead volume, close rate) are captured on the call;
      anything still unstated is flagged on the review screen and blocks generation, on the API as
      well as in the browser (`/api/generate` answers 422 with the figures it is still missing, so a
      blueprint can never be built on `null`)
- [ ] The lead payload records how the call ran (`voice_call`: provider, models, turns, probes,
      missing required figures at the end) and `audio_retained: false`
- [ ] No keys in the browser; PDF generated server-side; disclaimer + privacy notice before data

Automated checks (nothing needs to be running first: `test/harness.js` starts a dedicated server
for each test file):

```bash
node test/voice.js       # voice policy, capture state, OpenAI adapters, the four routes
node test/voice-openai.js# the whole ChatGPT path against a mock OpenAI endpoint (no key, no spend)
node test/ui-smoke.js    # drives the real frontend through the voice-first journey (jsdom);
                         # proves the AI speaks before any text input appears, and that a blocked
                         # microphone falls back to typing without losing the journey
node test/e2e.js         # API end-to-end across all four verticals (QA assertions)
node test/netlify-sim.js # invokes the Netlify functions with Lambda-style events
node test/pdfcheck.js    # validates PDF xref structure of generated samples
node test/brief-check.js # audits the app against the brief's own QA checklist: every blueprint item
                         # traces to a knowledge base entry (nothing invented), the pipeline stages and
                         # lead source mechanisms are the KB ones, defaults stay separate from custom
                         # items, the three cost-of-inaction bases use the client's numbers, compliance
                         # flags per vertical, UK English, the required figures block generation on the
                         # API, and no key or KB text reaches the browser
node test/ui-design.js   # design-system checks: the stylesheet parses, every class the app renders
                         # has a rule, the tokens clear WCAG AA, touch targets stay 44px, and the
                         # logo is never rendered bare on a dark surface
npm run test:all         # everything above

The harness starts each test's server with the per-IP voice rate limit relaxed
(`VOICE_RATE_PER_MIN=1000`) because one suite run drives about 40 turns a minute from a single IP.
The production default in `server.js` is unchanged, so the limiter still protects the deploy.
```

`test/mock-openai.js` is a stand-in OpenAI endpoint (turns, speech, transcription) so the ChatGPT
path can be exercised without an account:

```bash
node test/mock-openai.js 8099
OPENAI_API_KEY=sk-mock OPENAI_BASE_URL=http://127.0.0.1:8099/v1 PORT=8081 node server.js
```

## Files

```
pipelinesync/
  server.js              local dev server (zero deps): static + routes + local outbox
  lib/core.js            shared stateless core: KB v1, extract, generate, PDF writer, tokens
  lib/voice.js           the voice discovery call: intake plan, interviewer policy, capture state,
                         OpenAI adapters (turns, speech, transcription), turn runner
  lib/voice-api.js       the four /api/voice routes, shared by the dev server and Netlify
  netlify.toml           publish dir, functions dir, /api/* route mapping incl. /api/voice/*
  netlify/functions/     start (the name + email gate; login.js is its alias), logout, extract (A),
                         generate (B), deliver (C+D), voice, outbox, health
  public/index.html      shell (no CDN, works offline)
  public/logo.svg        brand mark as vector (faithful redraw of the logo-only.png artwork),
                         transparent: use it on light backgrounds
  public/logo-on-dark.svg  the same mark on a white rounded plate, for dark backgrounds
  public/favicon.svg     favicon: mark on a white rounded tile (referenced by index.html)
  public/favicon.ico     multi-size ICO fallback (16/32/48) for legacy browsers
  public/apple-touch-icon.png  180x180 iOS home-screen icon
  public/manifest.webmanifest  PWA manifest (installable, theme colour, icons)
  public/styles.css      design system + responsive layout (mobile-first, see below)
  public/app.js          SPA: entry gate, consent, the voice call, review, blueprint, unlock, booking, done
  test/                  voice, voice-openai, mock-openai, e2e, netlify-sim, pdfcheck, brief-check,
                         ui-smoke, ui-design, personas, sample PDFs
  docs/VOICE_SETUP.md    how to switch the ChatGPT voice layer on, verify it, cost it, fix it
  .env.example           every setting the app understands (copy to .env, which is gitignored)
  README.md              this file
```
