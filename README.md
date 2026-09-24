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
| `PS_TOKEN_SECRET` | any long random string of at least 16 characters, e.g. the output of `openssl rand -hex 24` | Signs the entry-gate session tokens and the voice call tickets. **Required in production**: without it the entry gate refuses to run, and the live voice routes additionally fail closed if it is missing, under 16 characters, or still the built-in development secret published in this repo - a forgeable token would let a stranger spend your OpenAI credit. Local development is unaffected. |
| `OPENAI_API_KEY` | your OpenAI key (`sk-...`) | **Switches the discovery call on to live AI voice**: one continuous WebRTC session (OpenAI Realtime) carries the whole call, and the same key drives the step-by-step fallback (wording, speech out, transcription in). Read inside the functions only, never sent to the browser. Without it the call runs on the built-in interviewer and the browser voice, so the demo still works. |
| `ANTHROPIC_MODEL` | e.g. `claude-sonnet-4-5-20250929` | Optional. Overrides the pinned default model in `lib/anthropic.js`. Read through `anthropic.resolveModel(env)` — no other file hardcodes a model id. |
| `NETLIFY_BLOBS_SITE_ID` / `NETLIFY_BLOBS_TOKEN` | Netlify site id + token | Optional. Only needed to reach the blueprint job store (Netlify Blobs) from outside a Netlify deploy context. On Netlify the context is injected automatically. |
| `GENERATE_INLINE` | `1` | Optional. Makes `/api/generate` run the job inline instead of invoking the background function (handy under `netlify dev`). |
| `ANTHROPIC_API_KEY` | your Anthropic key (`sk-ant-...`) | **Enables Claude AI for extraction and blueprint generation** (Functions A and B). When set, the extract and generate endpoints use Claude with Prompt B and Prompt A instead of the deterministic mock logic. The key is read server-side only — never sent to the browser. Without it the app falls back to deterministic extraction and generation (the demo still works). |
| `HUBSPOT_ACCESS_TOKEN` | Private App token (`pat-na1-...`) | **Live HubSpot contact upsert at the name+email gate**, then deal + note enrichment at PDF unlock. Scopes: `crm.objects.contacts.read/write`, `crm.objects.deals.read/write`. Server-side only. Without it, start/deliver stay mocked and the UI does not claim a CRM push. |
| `HUBSPOT_AUTO_CREATE_PROPS` | `true` / `false` (default off) | When true, missing `pipelinesync_*` contact and deal properties are created via `POST /crm/v3/properties/{contacts\|deals}` on first run. Needs `crm.schemas.contacts.write` and `crm.schemas.deals.write`. |
| `PDF_EMAIL_API_KEY` | Resend API key (`re_...`) | **Emails the finished PDF** to the lead as an attachment, with a branded HTML body. Server-side only. Without it the feature is off and `deliver` returns `email:{sent:false,error}`, so the finish screen says to download instead of claiming a send. |
| `PDF_EMAIL_FROM` | `PipelineSync AI <blueprints@yourdomain.com>` | The From header. **The domain must be verified in Resend (DNS records) before Resend delivers to anyone but the address that owns the account.** Use `onboarding@resend.dev` for testing only - see below. |
| `PDF_EMAIL_SUBJECT` | optional | Subject template. `{first_name}`, `{name}`, `{vertical}`, `{tier}`, `{date}` are filled in; the default is `Your PipelineSync blueprint is attached`. |
| `PDF_EMAIL_REPLY_TO` | optional | Reply-To address, so replies reach a real inbox. |
| `DELIVER_RATE_PER_MIN` | `5` (default) | Unlocks per minute per IP on `/api/deliver`. Each attempt builds a PDF and may send an email, so it is the tightest limit in the app. |
| `SCHEDULER_LINK` | `https://meetings.hubspot.com/...` | Public Meetings URL. When set, the booking screen embeds the real scheduler. |

Optional voice settings (`VOICE_REALTIME`, `OPENAI_REALTIME_MODEL`, `OPENAI_REALTIME_VOICE`,
`OPENAI_REALTIME_VAD`, `OPENAI_REALTIME_EAGERNESS`, `OPENAI_REALTIME_MAX_MIN`,
`OPENAI_REALTIME_MAX_TOOLS`, `OPENAI_REALTIME_TIMEOUT_MS`, `OPENAI_REALTIME_CONNECT_PER_MIN`,
`OPENAI_REALTIME_MAX_CONCURRENT`, `OPENAI_REALTIME_DAILY_MAX`, `OPENAI_REALTIME_IDLE_MIN`,
`VOICE_PROVIDER`, `OPENAI_CHAT_MODEL`, `OPENAI_TTS_MODEL`, `OPENAI_TTS_VOICE`, `OPENAI_STT_MODEL`,
`VOICE_STT`, `VOICE_LANGUAGE`, `VOICE_LOCALE`, `VOICE_MAX_TURNS`, `OPENAI_BASE_URL`) and everything
else about the voice layer is documented in `docs/VOICE_SETUP.md` (all of them are commented out in
`.env.example` with their defaults).

Later, when the remaining keys arrive, add them here too (they only reach the functions, never the
browser): `SUPABASE_URL`, `SUPABASE_SERVICE_KEY`, `HUBSPOT_ACCESS_TOKEN`,
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

### 5. Email the PDF (Resend)

`deliver` emails the finished blueprint to the lead as a PDF attachment, with a short branded HTML
body: a greeting using the first name from the session, three sentences taken only from the
blueprint (vertical, recommended tier, and the cost of inaction it already computed), "your
blueprint is attached as ...", and the booking button when `SCHEDULER_LINK` is set. It calls
Resend's REST API with plain `fetch`, so no npm package is added, and the recipient is **always the
address in the signed session token, never the address typed in the unlock form**, so the
attachment cannot be redirected by editing the page.

Set the four variables from the table above (`PDF_EMAIL_API_KEY`, `PDF_EMAIL_FROM`,
`PDF_EMAIL_SUBJECT`, `PDF_EMAIL_REPLY_TO` are optional apart from the first two).

**A verified sending domain is required before Resend will deliver to anyone.** Add the domain in
Resend → Domains and publish the SPF/DKIM DNS records it shows; until that verification is done,
Resend refuses every recipient except the address that owns the Resend account and answers with
`... The domain is not verified ...`. For a test deploy:

1. Set `PDF_EMAIL_FROM` to Resend's test sender, e.g.
   `PipelineSync AI <onboarding@resend.dev>` (testing only - mail sent from `resend.dev` is meant
   for your own address and is more likely to be marked as spam).
2. Unlock the PDF with the email address that owns the Resend account.
3. Once the domain verifies, change `PDF_EMAIL_FROM` to an address on that domain and redeploy.

Nothing about a failure is hidden: if the send fails, `deliver` still returns the PDF, the response
carries `email:{sent:false,error:"<the reason Resend gave>"}`, and the browser shows that as
"Couldn't email it - download below". A confirmed send is reported as `email:{sent:true,to:...}`
with the Resend id, and only then does the UI say the PDF was emailed. The HubSpot note written by
Function D records the same result (`Email: sent to ...` / `Email: NOT sent - ...`).

Free Resend accounts send 100 emails a day at 2 requests a second, and an email may be up to 40MB
including the base64 attachment (the blueprint PDF is well under 1MB).

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
   speaks the first question immediately. There is no second start button and no text box, and with a
   blocked microphone the typed fallback appears by itself.
   With `OPENAI_API_KEY` set the call is **continuous**: one WebRTC session (OpenAI Realtime) is open
   for the whole call, the microphone is opened once, and semantic turn detection decides when the
   client has finished a thought, so nothing is cut between questions and the client can talk over
   the AI. The model words the questions; the guardrail set in `lib/voice.js` still chooses them, and
   the server re-checks every value the model claims against the words it quotes before it is
   captured. Otto also answers the client's own questions ("what is PipelineSync?", "how much does it
   cost?", "are you an AI?", "what happens next?", "can we stop?") from a scripted FAQ that invents no
   number, and their question comes first: he answers it before returning to the intake set, a turn
   that is all answer is a correct turn (the question he did not reach stays pending, `deferred`), and
   when the client says stop the call ends on the spot (`KB-CALL-02`) whatever is still missing.
   It asks the 12-question intake set out loud, and probes once when an answer arrives without its
   figures. The transcript stays collapsed behind a link: the call is spoken. Typing lives behind
   *Type instead* (and turns on automatically if the browser blocks the microphone), and anything the
   client does not know can be skipped.
   If the browser has no WebRTC, the microphone is blocked, or the live session cannot be opened, the
   same call runs step by step instead (browser or OpenAI transcription, ChatGPT wording, OpenAI
   speech) - and a session that dies mid-call keeps everything already captured. Without a key the
   same guardrail set drives the call through the built-in interviewer and the browser voice
   (`docs/VOICE_SETUP.md`).
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
   generated by a pure-JS PDF writer in `lib/core.js` (no npm packages), inside the function, then
   emailed to the address in the session (Phase 3, Resend). The download never waits on the email:
   the finish screen shows the status the API reported ("Sent to you@x.com" or "Couldn't email it -
   download below") and the download button is always there.
8. **Lead captured** (Function D, mock of the HubSpot private-app-token push) - a lead with all
   answers and a blueprint reference is logged as `[hubspot-mock] lead push: ...`; when HubSpot is
   live, the contact note also records whether the email went out.
9. **Book a call** - mock of the embedded HubSpot Meetings scheduler (the real embed uses Allen's
   scheduler link in production).

## The brand: the logo and Otto

The logo and Otto the mascot are components, in `public/components/brand/`:

| Component | File | Used for |
|---|---|---|
| `LogoMark({ variant, size, animated })` | `Logo.js` | the S mark on its own; `animated` adds the flowing dots for loading screens |
| `Logo({ variant, size })` | `Logo.js` | mark + wordmark lockup |
| `Otto({ pose, avatar, size })` | `Otto.js` | the mascot, six poses, optional head-only avatar crop |
| `OttoAvatar({ pose, size, ring })` | `Otto.js` | the head-only figure with an optional orange ring; paints no background of its own |

They are the brand sheet's React components (`components/brand/Logo.tsx`, `components/brand/Otto.tsx`)
ported to the technology this prototype ships: `public/app.js` is plain HTML/CSS/JS with no build
step, so the components return markup strings that the app injects with the rest of its markup. The
SVG geometry, colours, stroke widths, view boxes and the inline animation CSS are the same markup.
`index.html` loads the two files before `app.js`.

Otto's pose is never a new flag: it is read from state the app already tracks, so the voice flow is
untouched.

| The app is | Otto is | Where |
|---|---|---|
| on the start screen | `hello` (200px) | next to "Start strategy session", with his greeting |
| reading the disclaimer | `hello`, avatar (96px) | the consent card |
| speaking a question | `speak`, avatar (104-140px, orange ring) | the live call panel |
| listening to the answer | `listen`, avatar (104-140px, orange ring) | the live call panel |
| waiting on the model / building the blueprint | `think` (170-180px) | the loader, with his loading line |
| on the results | `party` (180-200px) | the top of the blueprint, the done card and the delivery toast |
| with no captured data yet | `think` (170px) | the empty state: "No pipeline data yet" |
| after a failed turn | `think`, avatar (56px) | the error line under him |
| showing the transcript | `sync`, avatar (32px) | the AI's chat bubbles and the call header |

His copy is the brand sheet's five lines (`greeting`, `listening`, `loading`, `success`, `error`),
read from `window.PSBrand.OTTO_COPY` so the mascot and the app cannot drift apart.

The live call screen puts his avatar on the left with the orange pulsing ring and, on the right, the
"OTTO · QUESTION X OF Y" label, the question in large type, and the animated waveform (nine bars in a
`#8FB0D0` → `#FF7A1A` gradient). Every control, the progress track, the captured-signals sidebar and
the transcript are unchanged.

> **One name, said and seen.** Otto is what the client reads on screen *and* what they hear on the
> call: the identity line in `lib/voice.js` (`realtimeInstructions()`, `buildMessages()`), the first
> question's greeting, and `MASTER_INTERVIEW_IDENTITY` in `lib/prompts.js` all say "I am Otto from
> PipelineSync". Nothing else about the spoken content changed — the 12 questions, the FAQ answers
> and the call rules are word for word what they were, so the rename is a name and nothing more.

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

- **Colour is the brand mark** - the brand sheet's palette: navy `#0C2B5E` (Otto's head), steel
  `#3E6892` (his arms), steel-deep `#2E5580`, sync-orange `#FF7A1A` (primary buttons, live
  indicators), sky `#8FB0D0` (soft accents and the waveform) and mist `#E8EFF7` (the light circle
  Otto stands on). These are declared as tokens (`--navy-brand`, `--steel-brand`, `--steel-deep`,
  `--sync-orange`, `--sky`, `--mist`) alongside the design system's own compatibility tokens, not in
  place of them: the background stays `#0A0E17` (`--bg`, `--void`). Orange is the one fill that
  carries white text, because the brand sheet specifies it for primary buttons; every other pair is
  read back out of the stylesheet and asserted against WCAG AA (4.5:1, or 3:1 for large marks), and a
  redesign that drops a contrast ratio fails the build.
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
- **The logo and Otto are components, not artwork.** `public/components/brand/Logo.js` and
  `public/components/brand/Otto.js` are the brand sheet's `components/brand/{Logo,Otto}.tsx` ported
  to this no-build layer: same SVG markup, same geometry, same colours, same six poses, returned as
  markup strings instead of React elements. Nothing else in the app draws them, and neither is ever
  redrawn, recoloured or stretched (`logoTile()` fixes the mark's own 440x590 aspect ratio; every
  Otto figure is sized by `width`/`height` from the same 300x300 view box).
- **A light mark never sits on a dark surface.** The light variant is navy `#0C2B5E` and steel
  `#3E6892`, so on the topbar and the entry-gate hero it measures **1.2:1** and **3.4:1** and
  disappears. Two shapes are allowed and the design check enforces both: the light variant inside a
  white plate (`.logo-plate`, `logoTile()`, the 160px splash card) or the dark variant (white and
  sky), which is what the topbar and the call orb use. For decks and slides, `public/logo-on-dark.svg`
  is the same treatment as a standalone file.
- **Otto is transparent artwork: nothing paints behind him.** No plate, no circle, no ground
  shadow - `.otto-fig-card` (and every other figure wrapper) only reserves his space, and
  `OttoAvatar` draws just the optional orange ring, so the app's own surface shows through on dark,
  on light and in an export. His pose always comes from state the app already tracks
  (`ottoPoseNow()` reads the voice status and the stage) - never a new flag. His figures reserve a
  fixed box, so a pose change cannot shift the layout, and his motion stops under
  `prefers-reduced-motion`.
- **Accessibility is in the markup, not bolted on**: skip link, `aria-current="step"` on the rail,
  `aria-live` on the AI line and the call status, `aria-expanded` on both drawers, and visible
  `:focus-visible` rings throughout.

## Local vs deployed mapping

| Concern | Local (`node server.js`) | Netlify (GitHub deploy) |
|---|---|---|
| Auth | signed token (stateless) | signed token (stateless, same code) |
| Functions A-D + the email | routes in `server.js` (deliver via `lib/deliver-core.js`) | `netlify/functions/{extract,generate,deliver,...}.js` (deliver via the same `lib/deliver-core.js`) |
| Voice routes (`/api/voice/*`) | `lib/voice-api.js` mounted by `server.js` | `netlify/functions/voice.js` (same handler) |
| Lead outbox | in-memory, view at `/dev/outbox` | function logs (see `/dev/outbox` page) |
| Shared core | `lib/core.js` | `lib/core.js` (bundled into each function) |

| Prototype (this repo) | Production (per the brief) |
|---|---|
| Signed tokens from a name + email gate (`/api/auth/start`) | Supabase Auth: magic link or OTP on the same name + email fields |
| Voice discovery call (`lib/voice.js` + voice engine in `app.js`) | The same code, with `OPENAI_API_KEY` set: a continuous OpenAI Realtime (WebRTC) session carries the whole call, and the step-by-step pipeline (ChatGPT wording, OpenAI speech, OpenAI transcription) is the automatic fallback |
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
- [ ] The call is continuous: one WebRTC session and one microphone open for the whole call, no
      record/stop/play cycle between questions, and the client can interrupt the AI
- [ ] Otto answers the client's own questions (product, price, "are you an AI?", next step) briefly
      and honestly, and their question comes first: a turn that is all answer is fine, and the
      question he did not get to stays pending ("deferred") instead of being skipped
- [ ] When the client says stop, or that they have to go, the call ends at once, whatever is still
      missing; a request to pause makes him wait instead of hanging up
- [ ] Every one of the 12 questions is asked out loud exactly once, in order, with a probe only when
      an answer arrived without its figures
- [ ] Nothing is captured that the client did not say: every value carries the exact quoted words,
      figures lifted from on-screen examples are refused, and an off-topic turn captures nothing
- [ ] The three required fields (deal size, monthly lead volume, close rate) are captured on the call;
      anything still unstated is flagged on the review screen and blocks generation
- [ ] The lead payload records how the call ran (`voice_call`: provider, models, `transport`,
      realtime model/voice/turn detection, turns, probes, captures accepted and rejected,
      missing required figures at the end) and `audio_retained: false`
- [ ] No keys in the browser; PDF generated server-side; disclaimer + privacy notice before data
- [ ] The emailed PDF goes to the session address only: typing a different address in the unlock form
      does not redirect the attachment
- [ ] When Resend is not configured, or refuses the message, the UI says the email did not go out and
      still offers the download (it never claims a send the API did not confirm)

Automated checks (nothing needs to be running first: `test/harness.js` starts a dedicated server
for each test file):

```bash
node test/voice.js       # voice policy, capture state, the grounded-capture gate, OpenAI adapters,
                         # and the routes
node test/voice-openai.js# the whole step-by-step ChatGPT path against a mock OpenAI endpoint
node test/voice-realtime.js # a whole continuous call in jsdom: fake WebRTC, fake model, mock
                         # endpoint - one session, twelve questions, grounded captures, fallback
node test/ui-smoke.js    # drives the real frontend through the voice-first journey (jsdom);
                         # proves the AI speaks before any text input appears, and that a blocked
                         # microphone falls back to typing without losing the journey
node test/e2e.js         # API end-to-end across all four verticals (QA assertions)
node test/pdf-email.js   # Phase 3: the emailed PDF against a stubbed Resend - success, refusal,
                         # network error, timeout, recipient taken from the token (never the body),
                         # the HubSpot note line, and the 5 unlocks/minute/IP limit on both mounts
node test/netlify-sim.js # invokes the Netlify functions with Lambda-style events (incl. the
                         # Resend send with a stubbed fetch)
node test/pdfcheck.js    # validates PDF xref structure of generated samples
node test/ui-design.js   # design-system checks: the stylesheet parses, every class the app and the
                         # brand components render has a rule, the tokens clear WCAG AA, touch targets
                         # stay 44px, the brand tokens and icons are in place, the six Otto poses and
                         # his five copy lines are intact, the pose map follows the real call state,
                         # and neither the logo nor Otto is ever rendered bare on a dark surface
npm run test:all         # everything above
```

The harness starts each test's server with the per-IP voice rate limit relaxed
(`VOICE_RATE_PER_MIN=1000`) and the per-IP deliver limit relaxed the same way
(`DELIVER_RATE_PER_MIN=1000`) because one suite run drives about 40 turns and several unlocks a
minute from a single IP. It also strips every OpenAI, HubSpot and Resend credential, so a key in
your shell can never make a test spend money or send mail.
The production default in `server.js` is unchanged, so the limiter still protects the deploy.

`test/mock-openai.js` is a stand-in OpenAI endpoint (turns, speech, transcription, and
`POST /v1/realtime/calls` for the continuous call) so the ChatGPT path can be exercised without an
account:

```bash
node test/mock-openai.js 8099
OPENAI_API_KEY=sk-mock OPENAI_BASE_URL=http://127.0.0.1:8099/v1 PORT=8081 node server.js
```

## Files

```
pipelinesync/
  server.js              local dev server (zero deps): static + routes + local outbox
  lib/anthropic.js       Anthropic Claude API client (server-side only, key never reaches browser)
  lib/deliver-core.js    shared /api/deliver logic (PDF + Resend email + HubSpot) for the Netlify
                         function and the local server, so the two mounts cannot drift
  lib/pdf-email.js       Phase 3: branded HTML + plain-text email and the Resend REST call, with the
                         recipient taken from the signed token; never throws, never claims a send
                         Resend did not confirm
  lib/core.js            shared stateless core: KB v1, extract, generate, PDF writer, tokens
  lib/voice.js           the voice discovery call: intake plan, interviewer policy, capture state,
                         the grounded-capture gate, the FAQ, OpenAI adapters (turns, speech,
                         transcription), the turn runner, and the continuous-call (Realtime) engine
  lib/voice-api.js       the seven /api/voice routes (incl. realtime/connect, realtime/tool,
                         realtime/end), their rate limits, shared by the dev server and Netlify
  netlify.toml           publish dir, functions dir, /api/* route mapping incl. /api/voice/*
  netlify/functions/     start (the name + email gate; login.js is its alias), logout, ai (Claude API),
                         generate (B), deliver (C+D), voice, outbox, health
  public/index.html      shell (no CDN, works offline; includes pdfmake for client-side PDF)
  public/components/brand/Logo.js  the logo components: LogoMark (the S mark, with the animated
                         flowing-dot variant for loading screens) and Logo (mark + wordmark)
  public/components/brand/Otto.js  Otto the mascot: six poses (sync, hello, listen, speak, think,
                         party), the avatar crop, his five copy lines and his animation CSS
  public/logo.svg        brand mark as vector (faithful redraw of the logo-only.png artwork),
                         transparent: use it on light backgrounds
  public/logo-on-dark.svg  the same mark on a white rounded plate, for dark backgrounds
  public/favicon.svg     favicon: the light mark on a navy #0C2B5E rounded tile
  public/favicon.ico     multi-size ICO fallback (16/32/48) for legacy browsers
  public/app-icons.svg   the 512px PWA icon (maskable-safe tile)
  public/icon-512.png    the same tile at 512px, public/icon-maskable-512.png with more padding
  public/apple-touch-icon.png  180x180 iOS home-screen icon
  public/manifest.webmanifest  PWA manifest (installable, theme colour #0A0E17, icons)
  scripts/make-brand-assets.js  regenerates the favicon and app icons from the Logo component's
                         geometry (npm run brand:icons; needs @resvg/resvg-js, build-time only)
  public/styles.css      design system + responsive layout (mobile-first, see below)
  public/app.js          SPA: entry gate, consent, both voice engines (continuous WebRTC call and
                         step-by-step call), review, blueprint, unlock, booking, done
  test/                  voice, voice-openai, voice-realtime, mock-openai, e2e, pdf-email,
                         netlify-sim, pdfcheck, ui-smoke, ui-design, personas, sample PDFs
  docs/VOICE_SETUP.md    how to switch the voice layer on, verify it, cost it, fix it
  .env.example           every setting the app understands (copy to .env, which is gitignored)
  README.md              this file
```
