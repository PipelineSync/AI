# Nova PipelineSync AI - Prototype Build

Runnable prototype of the app described in `PipelineSync_AI_Developer_Brief.pdf`. Built to be
tested end to end in the browser. External services are live when their keys are set (HubSpot when
`HUBSPOT_ACCESS_TOKEN` is set, otherwise a `[hubspot-mock]` log line; Claude when `ANTHROPIC_API_KEY`
is set, otherwise built-in deterministic logic) and clearly marked, so nothing blocks on credentials - with one exception that
matters: **the discovery call voice layer is live when `OPENAI_API_KEY` is set, otherwise the
built-in interviewer runs.** ChatGPT words each turn when live, OpenAI speaks it, and the answers
are captured against the Section 7 data contract. See `docs/VOICE_SETUP.md` for the one environment
variable that switches it on.

The journey itself is **zero-touch by default** (`AUTO_DELIVER=true`): the visitor gives a name and
an email, the AI calls them, and the blueprint built by Claude downloads as a PDF right in the web
app - no review screen and no unlock button in between. The PDF is never emailed. One switch turns
that off (`docs/ZERO_TOUCH.md`).

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
git commit -m "Nova PipelineSync AI prototype: Netlify-ready (no Supabase)"
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
| `ANTHROPIC_API_KEY` | your Anthropic key (`sk-ant-...`) | **Enables Claude AI for extraction and blueprint generation** (Functions A and B). When set, the extract and generate endpoints use Claude with Prompt B and Prompt A instead of the built-in deterministic logic. The key is read server-side only — never sent to the browser. Without it the app falls back to deterministic extraction and generation (the demo still works). |
| `HUBSPOT_ACCESS_TOKEN` | Private App token (`pat-na1-...`) | **Live HubSpot contact upsert at the name+email gate**, then deal + note enrichment at PDF unlock. Scopes: `crm.objects.contacts.read/write`, `crm.objects.deals.read/write`. Server-side only. Without it, start/deliver stay mocked and the UI does not claim a CRM push. |
| `HUBSPOT_AUTO_CREATE_PROPS` | `true` / `false` (default off) | When true, missing `pipelinesync_*` contact and deal properties are created via `POST /crm/v3/properties/{contacts\|deals}` on first run. Needs `crm.schemas.contacts.write` and `crm.schemas.deals.write`. **Preferred:** run `npm run hubspot:setup` once (see `docs/HUBSPOT_SETUP.md`) — auto-create is now only a fallback on 400. |
| `HUBSPOT_TIMEOUT_MS` | `4000` (default) | Timeout ms for every HubSpot fetch via AbortController. |
| `HUBSPOT_START_BUDGET_MS` | `3500` (default) | Total budget ms for HubSpot capture at entry gate. If exceeded, responds with `hubspot:{ok:false,pending:true}` and no contact id in token; deliver finds/creates later. |
| `HUBSPOT_DEAL_AMOUNT` | optional | If set, used as deal `amount`; otherwise amount left empty (typical_deal_size stays only on contact). |
| `HUBSPOT_DEAL_PIPELINE` | optional | Internal pipeline ID for new deals (sets `pipeline`). |
| `HUBSPOT_DEAL_STAGE` | optional | Internal stage ID for new deals (sets `dealstage`). |
| `HUBSPOT_OWNER_ID` | optional | HubSpot owner ID to set as `hubspot_owner_id` on new contacts and deals. |
| `SUPABASE_URL` | `https://...supabase.co` | Supabase project URL. Server-only. When set with `SUPABASE_SECRET_KEY` and `PIPELINESYNC_WORKSPACE_OWNER_ID`, leads are persisted in `pipeline_leads`, `pipeline_lead_sessions`, `pipeline_blueprints`, `pipeline_lead_events`; otherwise leads live only in function logs and `/dev/outbox`. Partial config fails closed with a JSON 500. |
| `SUPABASE_SECRET_KEY` | secret | Supabase secret key (or legacy `SUPABASE_SERVICE_ROLE_KEY`). Server-only, never exposed. Required together with `SUPABASE_URL` and `PIPELINESYNC_WORKSPACE_OWNER_ID`. |
| `PIPELINESYNC_WORKSPACE_OWNER_ID` | UUID | `auth.users.id` of the workspace admin who owns incoming leads. Must be a valid UUID. Required together with Supabase URL and key. |
| `PRIVACY_POLICY_URL` | `https://...` | Privacy Policy URL, must be https. Returned by `/api/config` as `privacyPolicyUrl` and `consentVersion`. If unset, server logs warning and notice shown without link. **A real policy is required before public launch.** |
| `DELIVER_RATE_PER_MIN` | `5` (default) | Unlocks per minute per IP on `/api/deliver`. Each attempt builds a PDF server-side, so it is the tightest limit in the app. |
| `DELIVER_PER_EMAIL_DAY` | `3` (default) | Max 3 successful deliveries per email per 24h sliding window. Backed by Netlify Blobs with in-memory fallback. Past the cap, deliver returns 429. Tests set this high via `test/harness.js`. |
| `AUTO_DELIVER` | `true` (default) | **Zero-touch: name + email → AI voice call → the PDF, with nothing to click in between.** When on, after the call the browser structures the answers, builds the blueprint and downloads the PDF in the app automatically - no unlock click - and `/api/deliver` accepts `auto:true`, which records the consent given on the consent screen (with its timestamp) on the CRM note. Consent, the per-email/per-IP caps, idempotency and every required-figure check are unchanged; if the call ended without a required figure the browser asks for that one number instead of inventing it. The AI's closing line changes with it. Set `AUTO_DELIVER=false` and the blueprint still appears straight after the call, but the visitor ticks consent and clicks *Unlock official PDF* to download it. There is no review screen in either mode, and the PDF is never emailed. See `docs/ZERO_TOUCH.md`. |
| `TURNSTILE_SITE_KEY` | public site key | **Cloudflare Turnstile at the entry gate, env-gated**. When both site and secret are set, the start view renders the Turnstile widget (loads `https://challenges.cloudflare.com/turnstile/v0/api.js` only in that case) and `start.js` verifies the token via `POST https://challenges.cloudflare.com/turnstile/v0/siteverify` (secret, response, remoteip) BEFORE any Supabase or HubSpot write. Failure → 403. Returned by `/api/config` as `turnstileSiteKey`. When unset, behaviour is unchanged. |
| `TURNSTILE_SECRET_KEY` | secret key | Server-only secret for Turnstile verification. Never exposed to browser. |
| `DEMO_MODE` | `true` / `false` (default off) | When `true`, `/api/config` returns `demoMode:true` and the UI shows "Use the demo account" and the persona loader (its handlers exist at `app.js:2211,2236-2240` but no view rendered it before). When off, `start.js` rejects `demo@pipelinesync.ai`. |
| `SCHEDULER_LINK` | `https://meetings.hubspot.com/...` | Public Meetings URL. When set, the booking screen embeds the real scheduler; otherwise it falls back to "Request a time — we'll confirm by email". |
| `AI_EXTRACT_DEADLINE_MS` | `8000` (default) | Total deadline ms for `runExtract` (extract). Retries must fit inside remaining. Deadline hit → deterministic fallback `reason:"timeout"`. |
| `AI_GENERATE_DEADLINE_MS` | `60000` (default) | Total deadline ms for `runGenerate` (blueprint generation). |

The old email settings (`PDF_EMAIL_API_KEY`, `PDF_EMAIL_FROM`, `PDF_EMAIL_SUBJECT`,
`PDF_EMAIL_REPLY_TO`, `PDF_EMAIL_ENDPOINT`, `PDF_EMAIL_DAILY_MAX`, `EMAIL_VERIFY`,
`EMAIL_VERIFY_CODE_TTL_MIN`, `EMAIL_VERIFY_MAX_SENDS_HOUR`, `EMAIL_VERIFY_MAX_ATTEMPTS`) are ignored
now that the PDF is download-only, and can be deleted from the host.

Optional voice settings (`VOICE_REALTIME`, `OPENAI_REALTIME_MODEL`, `OPENAI_REALTIME_VOICE`,
`OPENAI_REALTIME_EAGERNESS`, `OPENAI_REALTIME_MAX_MIN`, `OPENAI_REALTIME_MAX_TOOLS`, `OPENAI_REALTIME_TIMEOUT_MS`,
`OPENAI_REALTIME_CONNECT_PER_MIN`, `OPENAI_REALTIME_MAX_CONCURRENT`,
`OPENAI_REALTIME_DAILY_MAX`, `OPENAI_REALTIME_IDLE_MIN`,
`VOICE_PROVIDER`, `OPENAI_CHAT_MODEL`, `OPENAI_TTS_MODEL`, `OPENAI_TTS_VOICE`, `OPENAI_STT_MODEL`,
`VOICE_STT`, `VOICE_LANGUAGE`, `VOICE_LOCALE`, `VOICE_MAX_TURNS`, `OPENAI_BASE_URL`) and everything
else about the voice layer is documented in `docs/VOICE_SETUP.md` (all of them are commented out in
`.env.example` with their defaults).

The Supabase tables and a ready-to-copy readiness check live in `supabase/` (`pipelinesync_ai_schema.sql`, `verify_setup.sql`).

### 4. Test the deployment

Open your `https://<site>.netlify.app` URL:

1. **Use the demo account** → tick consent → pick a persona in the intake sidebar
   (solar, medical, home services, e-commerce) → *Load demo answers*.
2. **Zero-touch (default):** *Build my blueprint* → the loader reports real server progress → the
   blueprint appears and the PDF downloads in the app. No review screen, no unlock step; the
   delivered card shows the PDF's file name.
   **Manual mode (`AUTO_DELIVER=false`):** the blueprint appears straight after the call as well →
   tick consent → *Unlock official PDF* → the PDF downloads. Nothing is emailed in either mode.
3. **Find the lead:** When `HUBSPOT_ACCESS_TOKEN` is set, the lead is live in HubSpot (contact + deal + note); when `SUPABASE_URL`, `SUPABASE_SECRET_KEY` and `PIPELINESYNC_WORKSPACE_OWNER_ID` are set, it is also persisted in Supabase. Otherwise, Netlify dashboard → site → **Functions** → `deliver` → **Logs** shows each push as a line starting `[hubspot-mock] lead push:` with the full payload (email, all answers, blueprint reference). The `/dev/outbox` page on the site explains this too and lists leads when Supabase is not configured.
4. Book a call, finish, run a second business. Every `git push` to `main` auto-redeploys.

### 5. Getting the PDF

The finished blueprint is **only downloaded in the web app** - it is never emailed, so there is no
mail provider to configure. `deliver` (`lib/deliver-core.js`, shared by the Netlify function and the
local server) requires the session token, a `jobId` and `consent:true`, builds the PDF server-side
from the stored job (or the server-signed `jobSeal`), and returns it to the browser as base64, which
the browser saves as a file. In the same call it pushes the lead to HubSpot (or logs
`[hubspot-mock]`) and saves it to Supabase when configured; a Supabase failure never blocks the PDF.

It allows 5 requests a minute per IP (`DELIVER_RATE_PER_MIN`) and 3 deliveries a day per email
(`DELIVER_PER_EMAIL_DAY`), and it is idempotent: a repeat returns the same PDF with `duplicate:true`
and creates no new deal. The HubSpot note written by Function D records
`PDF: downloaded by the lead in the web app (not emailed)`.

### Important notes for the test deploy

- **There is no login**: the app opens on a name + email gate and hands back a signed session
  token, so anyone with the link can start a call and create a lead. Treat the deployment as an
  internal test link. To lock it down, add Netlify **Password protection** (Site configuration →
  Domain management → Password protection - free, per domain), or switch on Supabase Auth
  (magic link or OTP on the same two fields - the API shape does not change).
- **Do not collect real business data** in this deployment unless you have configured persistence: without Supabase (`SUPABASE_URL`, `SUPABASE_SECRET_KEY`, `PIPELINESYNC_WORKSPACE_OWNER_ID`) there is no persistent store and leads live only in the function logs and `/dev/outbox`; with Supabase configured they are persisted in `pipeline_leads`, `pipeline_lead_sessions`, `pipeline_blueprints`, and `pipeline_lead_events`. When `HUBSPOT_ACCESS_TOKEN` is set, leads are also pushed live to HubSpot (contacts, deals, notes), otherwise they are logged as `[hubspot-mock]`.
- Serverless means **no shared memory**: sessions are HMAC-signed tokens (stateless), the
  blueprint travels with the request, and the PDF is returned to the browser as base64. That is
  why the app works across cold starts with zero database.

## The journey (matches Section 4 of the brief)

1. **Enter your name and email** - the entry gate, no password. The name is what the AI calls the
   client on the call and what lands on the HubSpot lead; the email identifies the lead.
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
   captured. Nova also answers the client's own questions ("what is PipelineSync?", "how much does it
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
4. **Structure the answers** (Function A, live when `ANTHROPIC_API_KEY` is set, otherwise built-in deterministic logic + Prompt B) - transcript answers are mapped to the Section 7 data contract. Unstated values come back as `null`; prices and tool names are preserved exactly, not corrected.
5. **The hand-off** - in zero-touch (default) there is no review screen: the answers are structured and the blueprint is built immediately. The one exception is a required figure the call did not capture - then a short card asks for exactly that number (never a guess), and the journey continues. With `AUTO_DELIVER=false` the hand-off is the same - there is no review screen in either mode - and the blueprint appears straight after the call; only the PDF waits for the visitor's consent tick and *Unlock official PDF* click.
6. **Generate the blueprint** (Function B, live when `ANTHROPIC_API_KEY` is set, otherwise built-in deterministic logic + Prompt A) - built strictly from the knowledge base v1 (server-side). Every KB item used is tagged with an id (see the chips at the bottom of the blueprint) so the "no invented items" QA check is auditable.
7. **Deliver the PDF** (Function C, real server-side PDF) - downloaded in the web app, never emailed. In zero-touch the browser asks for it automatically (`auto:true`) and downloads it with no unlock click; with `AUTO_DELIVER=false` the visitor ticks consent and clicks *Unlock official PDF*. The success card shows the file name and the done screen reads "Your blueprint is ready to download".
8. **Lead captured** (Function D, live when `HUBSPOT_ACCESS_TOKEN` is set, otherwise `[hubspot-mock]` log line) - a lead with all answers and a blueprint reference is pushed to HubSpot when live, otherwise logged as `[hubspot-mock] lead push: ...`; when HubSpot is live, the note records that the PDF was downloaded in the web app (not emailed).
9. **Book a call** - live when `SCHEDULER_LINK` is set, otherwise fallback request picker (the real embed uses the configured HubSpot Meetings scheduler link).

## The brand: Nova PipelineSync AI

The brand components live in `public/components/brand/` and return plain HTML/SVG
strings. `index.html` loads them before `app.js`; there is no runtime dependency
or build step for the app.

| Component | File | Used for |
|---|---|---|
| `LogoMark({ variant, size, animated })` | `Logo.js` | Nova's three incoming lines/dots and four-quadrant star (the v3 spark is retired); `size` is height, width is `size × 220 / 140`. Retained as a brand component and the source of the `logo*.svg` exports, but no longer rendered anywhere in the app |
| `Logo({ variant, size })` | `Logo.js` | the PipelineSync S-mark raster beside real HTML text: **Nova**, then **PipelineSync AI** (the **AI** in ember 700); accessible name “Nova PipelineSync AI”. Used in the signed-in topbar |
| `SMark({ size })` | `Logo.js` | the PipelineSync S-mark alone (no wordmark), white with the site navbar's ember glow. Used in the upper-left corner of the login screen |
| `Nova({ pose, avatar, size })` / `NovaAvatar({ pose, size, ring })` | `Nova.js` | retained mascot component API (recoloured with the neon palette); not rendered in the current app |

`Logo.js` is the geometry source of truth for Nova's mark (`NOVA_MARK`):
viewBox `0 0 220 140`, three round-capped 10px lines, three 9px dots at their
origins, one 4-quadrant star, in that paint order. The **light** palette uses
navy `#0E1C36` lines, blue `#4C8DFF` dots and the ember `#F97A1A` star; the
**dark** palette uses blue `#4C8DFF` lines, blue-soft `#8FB6FF` dots and the
same ember star. Never stretch the mark.

The S-mark raster (`public/components/brand/pipelinesync-mark.png`, a 478×641
four-bit palette PNG copied from the PipelineSync website) is the product's
identity in the lockup, the favicon and the app icons. On screen it renders
white — `filter: brightness(0) invert(1)` — with the site navbar's ember glow;
the favicon and app icons recolor it white via `feColorMatrix` and re-add the
dot from the mark's own orange pixels at their measured centre (0.638, 0.559).

The app is **dark-only**, on the PipelineSync website's “Ember/Navy” neon
theme: one deep-navy canvas `#040B16` with `#081226` sunk panels, glass cards
(white gradient over `backdrop-filter: blur(20px) saturate(150%)`), a 56px
hairline grid, the blue top-glow and the two drifting aurora orbs (34s/42s
cycles). `state.theme` is pinned to `dark`, `applyTheme()` marks the body
dataset only, and there is no light variant, no toggle and no `ps_theme`
persistence to read. Glass surfaces are always translucent, so a light mark
never sits on a light surface. The Nova star-mark logo no longer appears
anywhere in the app — the voice orb is a plain deep-navy disc, and the loading
and done screens show no mark — but the **Nova name stays**: the login
screen's centered hero leads with **Nova AI** in the accent gradient, above
the value-proposition heading. The only on-screen logos are the PipelineSync
S-mark — the full lockup in the signed-in topbar and the S-mark alone in the
upper-left corner of the login screen. At narrow header widths the product
name is shortened to **Nova**, rather than cropping the text.
`prefers-reduced-motion` removes the aurora drift and stops the 8s accent
gradient.

### Generated brand assets

Run `npm run brand:icons` after a geometry change. The generator
(`scripts/make-brand-assets.js`) is **pure Node** — it decodes the mark PNG
with `zlib` and rasterizes the tiles with its own RGBA encoder — so it needs no
build-time package at all (the old `@resvg/resvg-js` dev dependency is gone).
The files below are committed:

```sh
npm run brand:icons
```

| Asset | Treatment |
|---|---|
| `public/logo.svg` | light mark, transparent background |
| `public/logo-on-dark.svg` | dark mark directly on the deep navy `#040B16` |
| `public/logo-lockup.svg`, `public/logo-lockup-dark.svg` | two-line wordmark beside the light/dark mark |
| `public/favicon.svg`, `public/favicon.ico` | deep-navy `#040B16` tile, white S-mark via `feColorMatrix`, ember dot at the mark's own orange centre; ICO contains 16/32/48px PNGs |
| `public/app-icons.svg`, `public/icon-512.png` | deep-navy 512px tile, white S-mark at 72% width, ember dot |
| `public/apple-touch-icon.png` | same navy icon at 180px |
| `public/icon-maskable-512.png` | navy tile; the whole S-mark at 50% width so every ink pixel, including the dot, sits inside the central 80%-diameter safe circle |

Tiles use a corner radius of 22% of tile size. The mark sits centred and
undistorted at 72% tile width; the maskable icon uses 50% because the tall
S-mark's ink reaches near its canvas corners (the test pixel-decodes the
maskable icon and fails if any ink leaves the safe circle). The PDF header is
text-only and uses **Nova PipelineSync AI**; no mascot or old
artwork is embedded. App metadata uses the full name and the short name
**Nova**, on the deep-navy `#040B16` theme colour. Branding changes must not
rename routes, environment variables, HubSpot properties, `pipelinesync_ai`,
Supabase tables, or existing test/export filenames.

**One name, said and seen.** Nova is what the client reads on screen *and* what they hear on the
call. The step-by-step identity and first greeting, `MASTER_INTERVIEW_IDENTITY` in `lib/prompts.js`,
and the Realtime opening all identify Nova as an AI from PipelineSync. The opening uses the caller's
first name when available, stays within two short statements and one question, and says the call
usually takes five to ten minutes. Realtime keeps the 12 topic examples and FAQ facts while using
flexible topic order, concise phone-call turns, grounded multi-topic capture, Taglish-aware English
replies, and gentle silence check-ins.

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

- **Colour is the brand mark, on one dark canvas** - the Ember/Navy neon palette from the
  PipelineSync website. Deep navy `#040B16` canvas with `#081226` sunk panels, mist `#F4F7FF`
  text, muted `#B7C3DE`, ember `#F97A1A` (soft `#FFB25C`) for primary buttons and accents,
  sky `#4C8DFF` (soft `#8FB6FF`) for links and the AI line. All of it is declared as tokens
  in `:root` (`--sync-orange`, `--sky`, `--mist`, `--void`, `--bg`, ...). The primary button is
  the ember gradient with the deep warm **ink** text `#1A0C02` (it clears 4.5:1, so no
  white-on-brand text exists anywhere in the stylesheet). Every text/background pair is read
  back out of the stylesheet and asserted against WCAG AA (4.5:1, or 3:1 for large marks and
  the icon tiles), and a redesign that drops a contrast ratio fails the build. The canvas is
  the site's: a blue top-glow, the 56px hairline grid and the two aurora orbs drifting on
  34s/42s cycles behind translucent glass panels.
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
- **The Nova mark's geometry is pinned even though it's off-screen.** Component
  and generated SVG tests pin the `220:140` viewBox ratio, the three 10px lines,
  three 9px dots and the single 4-quadrant star (paint order included) and both
  theme palettes, so the `logo*.svg` exports stay exact. The S-mark lockup keeps
  its real HTML wordmark and the S-mark raster's measured proportions.
- **A light mark never sits on a dark surface.** The app is dark-only, so every
  surface selects the dark variant. There are no white logo plates. Tests measure
  dark-mark contrast on the deep navy `#040B16` and require the S-mark silhouette
  and its ember dot to clear 3:1 against the navy tile, and they pixel-decode the
  maskable icon to keep every ink pixel inside the 80% safe circle.
- **Nova is retained but off-screen.** The mascot component (`Nova.js`) and the Nova mark
  component (`LogoMark` in `Logo.js`) are recoloured with the neon palette and keep their full
  geometry, pose API, reduced-motion CSS and copy lines, but the current app renders none of
  the Nova artwork - no figure, no avatar, no greeting line, and no mark in the orb, the
  loader or the done screen. The only on-screen logos are the PipelineSync S-mark (the topbar
  lockup and the login screen's upper-left corner); the Nova name itself stays on screen —
  leading the login hero, and on the AI line, the call screen and in the PDF header.
- **Accessibility is in the markup, not bolted on**: skip link, `aria-current="step"` on the rail,
  `aria-live` on the AI line and the call status, `aria-expanded` on both drawers, and visible
  `:focus-visible` rings throughout.

## Local vs deployed mapping

| Concern | Local (`node server.js`) | Netlify (GitHub deploy) |
|---|---|---|
| Auth | signed token (stateless) | signed token (stateless, same code) |
| Functions A-D | routes in `server.js` (deliver via `lib/deliver-core.js`) | `netlify/functions/{extract,generate,deliver,...}.js` (deliver via the same `lib/deliver-core.js`) |
| Voice routes (`/api/voice/*`) | `lib/voice-api.js` mounted by `server.js` | `netlify/functions/voice.js` (same handler) |
| Lead outbox | in-memory, view at `/dev/outbox` | function logs (see `/dev/outbox` page) |
| Shared core | `lib/core.js` | `lib/core.js` (bundled into each function) |

| Prototype (this repo) | Production (per the brief) |
|---|---|
| Signed tokens from a name + email gate (`/api/auth/start`) | Supabase Auth: magic link or OTP on the same name + email fields |
| Voice discovery call (`lib/voice.js` + voice engine in `app.js`) | The same code, with `OPENAI_API_KEY` set: a continuous OpenAI Realtime (WebRTC) session carries the whole call, and the step-by-step pipeline (ChatGPT wording, OpenAI speech, OpenAI transcription) is the automatic fallback |
| `extract` (built-in deterministic parser in `lib/core.js`, live when `ANTHROPIC_API_KEY` is set) | Function A: Claude + Prompt B |
| `generate` (KB-driven logic, live when `ANTHROPIC_API_KEY` is set, otherwise built-in) | Function B: Claude + Prompt A |
| `deliver` (pure-JS PDF writer) | Function C: server-side PDF generator |
| `[hubspot-mock]` log line in `deliver` when `HUBSPOT_ACCESS_TOKEN` is unset, otherwise live push | Function D: HubSpot private app token push |
| `KB` object in `lib/core.js` | Supabase tables: rules, tools, prices, vertical recipes, intake set |
| Fallback request picker in `app.js` when `SCHEDULER_LINK` is unset, otherwise embedded Meetings | Embedded HubSpot Meetings scheduler |
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
- [ ] Nova answers the client's own questions (product, price, "are you an AI?", next step) briefly
      and honestly, and their question comes first: a turn that is all answer is fine, and the
      question he did not get to stays pending ("deferred") instead of being skipped
- [ ] When the client says stop, or that they have to go, the call ends at once, whatever is still
      missing; a request to pause makes him wait instead of hanging up
- [ ] Each of the 12 topics is covered at most once; Nova may follow the caller's conversational
      order, skips volunteered/captured topics, and never asks again for a topic already answered
- [ ] A short, specific acknowledgement and one natural question follow each caller turn; multiple
      volunteered topics from one turn are captured separately without waiting for server validation
- [ ] Caller interruptions stop Nova's audio immediately; quiet at about 8 seconds gets "Take your
      time", at about 20 seconds Nova offers a skip, and silence does not trigger an early hang-up
      (the existing long idle wrap-up remains only as a last resort)
- [ ] Nothing is captured that the client did not say: every value carries the exact quoted words,
      figures lifted from on-screen examples are refused, and an off-topic turn captures nothing
- [ ] The three required fields (deal size, monthly lead volume, close rate) are captured on the call;
      anything still unstated is flagged on the review screen and blocks generation
- [ ] The lead payload records how the call ran (`voice_call`: provider, models, `transport`,
      realtime model/voice/turn detection, turns, probes, captures accepted and rejected,
      `median_ms`, `p90_ms`, `turns_measured`, missing required figures at the end) and
      `audio_retained: false`
- [ ] No keys in the browser; PDF generated server-side; disclaimer + privacy notice before data
- [ ] The PDF downloads in the web app in both modes (automatically in zero-touch, after
      *Unlock official PDF* with `AUTO_DELIVER=false`), and nothing is emailed: there is no
      "Email me a copy", code or resend control

Automated checks (nothing needs to be running first: `test/harness.js` starts a dedicated server
for each test file):

```bash
node test/voice.js       # voice policy, capture state, the grounded-capture gate, OpenAI adapters,
                         # and the routes
node test/voice-openai.js# the whole step-by-step ChatGPT path against a mock OpenAI endpoint
node test/voice-realtime.js # a whole continuous call in jsdom: fake WebRTC, fake model, mock
                         # endpoint - one session, flexible topic coverage, grounded captures, fallback
node test/ui-smoke.js    # drives the real frontend through the voice-first journey (jsdom);
                         # proves the AI speaks before any text input appears, and that a blocked
                         # microphone falls back to typing without losing the journey
node test/e2e.js         # API end-to-end across all four verticals (QA assertions)
node test/deliver.js     # /api/deliver (npm run test:deliver): blueprint built server-side only via
                         # jobId, nothing emailed even with a leftover email key, the HubSpot note
                         # wording, the 5/minute limit, idempotent repeats, a Supabase failure that
                         # does not block the PDF, and the local server mounting the same path
                         # (/api/deliver/code returns 404)
node test/netlify-sim.js # invokes the Netlify functions with Lambda-style events
node test/pdfcheck.js    # validates PDF xref structure of generated samples
node test/ui-design.js   # design-system checks: the stylesheet parses, every class the app and the
                         # brand components render has a rule, the tokens clear WCAG AA, touch targets
                         # stay 44px, the brand tokens and icons are in place, the six Nova poses and
                         # his five copy lines are intact, the pose map follows the real call state,
                         # and neither the logo nor Nova is ever rendered bare on a dark surface
npm run test:all         # everything above
```

The harness starts each test's server with the per-IP voice rate limit relaxed
(`VOICE_RATE_PER_MIN=1000`) and the per-IP deliver limit relaxed the same way
(`DELIVER_RATE_PER_MIN=1000`) because one suite run drives about 40 turns and several unlocks a
minute from a single IP. It also strips every OpenAI and HubSpot credential, so a key in your shell
can never make a test spend money.
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
  lib/deliver-core.js    shared /api/deliver logic (server-side PDF for download + HubSpot +
                         Supabase) for the Netlify function and the local server, so the two mounts
                         cannot drift; it never emails anything
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
  public/components/brand/Logo.js  Nova mark geometry (export-only), S-mark lockup + SMark corner logo
  public/components/brand/Nova.js  retained mascot component (not rendered in the current UI)
  public/components/brand/pipelinesync-mark.png  the PipelineSync S-mark raster (favicon/app-icon source)
  public/logo.svg        transparent light Nova mark
  public/logo-on-dark.svg  dark Nova mark directly on the #040B16 deep navy
  public/logo-lockup.svg, public/logo-lockup-dark.svg  mark + two-line wordmark
  public/favicon.svg     navy #040B16 tile, white S-mark, ember dot at the mark's orange centre
  public/favicon.ico     16/32/48 PNG entries of the navy tile
  public/app-icons.svg, public/icon-512.png  navy 512px tile, white S-mark at 72%, ember dot
  public/icon-maskable-512.png  navy tile, S-mark at 50% inside the central 80% safe circle
  public/apple-touch-icon.png  navy tile at 180x180
  public/manifest.webmanifest  Nova PipelineSync AI / Nova; dark-only #040B16 theme
  scripts/make-brand-assets.js  pure-Node generator for all vectors and rasters (no build deps)
  public/styles.css      design system + responsive layout (mobile-first, see below)
  public/app.js          SPA: entry gate, consent, both voice engines (continuous WebRTC call and
                         step-by-step call), review, blueprint, unlock, booking, done
  test/                  voice, voice-openai, voice-realtime, mock-openai, e2e, deliver,
                         netlify-sim, pdfcheck, ui-smoke, ui-design, personas, sample PDFs
  docs/VOICE_SETUP.md    how to switch the voice layer on, verify it, cost it, fix it
  docs/neon-migration.md the v5 Ember/Navy neon theme audit (old -> new, every retired token)
  .env.example           every setting the app understands (copy to .env, which is gitignored)
  README.md              this file
```
