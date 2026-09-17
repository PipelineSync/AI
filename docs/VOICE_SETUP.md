# Voice setup: ChatGPT takes over the discovery call

This is the operator guide for the voice layer. It covers what the layer does, the one thing you
must set in Netlify, how to verify it is really ChatGPT talking, what it costs, and what to do when
something misbehaves.

---

## 1. What actually happens on a discovery call

The call is turn-based voice, not text chat and not a realtime stream:

```
                 microphone                OpenAI                    OpenAI
 client speaks ──────────────► transcript ─────────► next line ─────────────► audio
                 (browser or /transcribe)   (/voice/turn, guardrail set)   (/voice/speech)
```

1. **The AI speaks first, the moment the disclaimer is agreed.** Agreeing to the AI disclaimer and
   privacy notice is the click that starts the call: the screen switches to the live call, the AI
   speaks, and then it listens. There is no second start button and no text box - the call is voice
   from the first second. The opening line is fetched while the client is reading the notice, so it
   plays inside that click rather than after a round trip (measured at roughly 50 to 150 ms).
   Two browser rules shape this, both already handled:
   - sound needs a user gesture, so the first line is played inside the click that agrees to the
     disclaimer rather than after an async gap (if a line is ever held back, any tap or the
     "Play the line" button releases it);
   - Chrome drops the very first browser utterance while its voice list loads, so the client waits
     for the voices (up to 700 ms) and retries once if the utterance was swallowed.
   If the notice is agreed faster than the voice layer warms up, the call still starts and the
   client is told the voice is being prepared; the same fallbacks cover it.
2. **The client answers out loud.** The browser transcribes free of charge when it can
   (`SpeechRecognition`); otherwise the recording is uploaded to OpenAI transcription
   (`/api/voice/transcribe`). The mic stops itself once it hears a pause.
3. **ChatGPT decides the wording, the guardrail set decides the content.** The 12 intake questions
   live in `lib/voice.js` (`INTAKE_PLAN`). Each turn the server tells the model exactly which
   question is due and asks it for one short spoken line (strict JSON schema). The model cannot
   wander off the intake set, cannot invent a figure, and cannot skip a question the blueprint
   needs. If an answer landed without its figures, the same question gets one probe.
4. **Captured data is checked live, twice.** The deterministic Function A parser reads the running
   transcript (that is what the sidebar shows), and the model also reports what it clearly heard.
   Anything the model heard that the parser did not catch appears on the review screen as
   "The AI heard ... on the call. Use this".
5. **Three required fields must land:** typical deal size, monthly lead volume, close rate. If the
   call ends without them the AI asks again (a callback), and if the client declines or skips, the
   review screen blocks generation until a human fills them in. Nothing is ever invented.

Why not realtime (WebRTC) voice? The client chose the turn-based pipeline: it works in every
browser, it is easy to audit against the Section 7 data contract, and it keeps the per-call cost
predictable. Realtime can be added later behind the same `/api/voice/*` surface.

---

## 2. Turn it on

The only required setting is the OpenAI key. It is read **inside** the serverless functions, so it
never reaches the browser.

### Netlify (the live site)

1. Netlify dashboard → your site → **Site configuration → Environment variables → Add a variable**.
2. Add `OPENAI_API_KEY` = your key (`sk-...`). Keep the scope to Functions (the default is fine).
3. Add `PS_TOKEN_SECRET` if you have not already (any long random string) so login tokens and voice
   call tickets are signed with your own secret.
4. **Deploys → Trigger deploy → Deploy site.** Environment changes need a redeploy for functions to
   pick them up.
5. Optional, same screen (defaults shown; see section 4 for when to change them):

   | Variable | Default | What it does |
   |---|---|---|
   | `VOICE_PROVIDER` | `openai` when the key is set | Set to `simulated` to force the built-in interviewer even with a key |
   | `OPENAI_CHAT_MODEL` | `gpt-4o-mini` | The turn brain (words each line) |
   | `OPENAI_TTS_MODEL` | `gpt-4o-mini-tts` | The voice the client hears |
   | `OPENAI_TTS_VOICE` | `alloy` | alloy, ash, ballad, coral, echo, sage, shimmer, verse |
   | `OPENAI_STT_MODEL` | `gpt-4o-transcribe` | Only used when the browser cannot transcribe |
   | `VOICE_STT` | `auto` | `auto` (browser first), `browser`, or `openai` (always upload) |
   | `VOICE_LANGUAGE` | `en` | Language code sent to the transcription model |
   | `VOICE_LOCALE` | `en-PH` | Locale for the browser microphone |
   | `VOICE_MAX_TURNS` | `40` | Spend guard: a runaway call is refused before it costs anything |
   | `OPENAI_BASE_URL` | `https://api.openai.com/v1` | For a gateway, an Azure-compatible endpoint, or a mock |

### Local (with a USD 5 balance: the 3-step version)

```bash
cp .env.example .env          # .env is gitignored
# edit .env: OPENAI_API_KEY=sk-...   (no quotes, no spaces)
npm install                   # only needed once, for the test suite
npm run check:openai          # real but tiny: chat + speech + transcription, well under USD 0.01
node server.js                # startup log must say: Discovery call voice: openai
```

`npm run check:openai` is the fastest way to tell a bad key from an empty balance from a model your
project cannot use - it prints one PASS/FAIL line per model and a plain-language reason. Use
`npm run check:openai -- --chat-only` for the cheapest possible probe.

**Making USD 5 last.** At roughly USD 0.06 per completed call that is about 80 calls, and about 60
if the browser never transcribes. To stretch it: keep `VOICE_STT=auto` (Chrome/Edge transcribe for
free), keep `OPENAI_CHAT_MODEL=gpt-4o-mini`, set `VOICE_MAX_TURNS=30`, and set a hard monthly budget
under OpenAI **Settings -> Limits** so nothing can run past the credit. Speech is the bulk of the
bill, so short lines matter more than the chat model. Demo and test runs cost nothing: use
`VOICE_PROVIDER=simulated`, or the bundled mock endpoint below.

### Local

```bash
# with the real key (never commit this file: .env is gitignored, copy .env.example)
OPENAI_API_KEY=sk-... node server.js

# without a key: the call still runs, worded by the built-in interviewer and spoken by the browser
node server.js

# or point it at the bundled mock OpenAI so you can see the ChatGPT path with zero spend
node test/mock-openai.js 8099 &
OPENAI_API_KEY=sk-mock OPENAI_BASE_URL=http://127.0.0.1:8099/v1 PORT=8081 node server.js
```

The server prints which voice mode is live on startup, e.g.
`Discovery call voice: openai (chat gpt-4o-mini, speech gpt-4o-mini-tts voice alloy, transcription gpt-4o-transcribe)`.

---

## 3. Verify it is really ChatGPT talking

1. **On screen.** The call panel shows a badge: **ChatGPT voice** when the key is live, **Simulated
   voice** when it is not, with the reason underneath. The sidebar also lists the models in use.
2. **In the function logs.** Netlify → Functions → `voice` → every turn logs one line:
   `[voice] turn 7 mode=openai ask=volumes kind=question captured=18/23 skipped=0 missing_required=[]`.
   `mode=openai` means ChatGPT worded and spoke that turn.
3. **On the lead.** After the PDF is unlocked the lead in `/dev/outbox` (or the Netlify function
   logs for `deliver`) carries a `voice_call` block: provider, models, voice, turns, which questions
   were asked, how many probes, whether the three required fields were still missing at the end, and
   `"audio_retained": false`.
4. **Automated.** `node test/voice-openai.js` runs the whole ChatGPT path against a mock endpoint
   and asserts the strict-schema call, the speech audio, the transcription upload and the captured
   contract. `node test/voice.js` asserts the guardrail policy and the routes. `node test/ui-smoke.js`
   drives the real frontend: it proves the AI speaks before any text input appears.

---

## 4. Cost

Approximate, per completed call (about 15 turns, roughly 3 to 5 minutes of speech). Prices move, so
treat these as order-of-magnitude:

| Part | Model | Typical cost per call |
|---|---|---|
| Turn wording | `gpt-4o-mini` | under USD 0.01 |
| Speech out (the bulk) | `gpt-4o-mini-tts` | ~USD 0.05 |
| Transcription in | `gpt-4o-transcribe` | ~USD 0.02, **zero** when the browser transcribes |
| | | **~USD 0.06 with browser transcription, ~USD 0.08 without** |

Knobs if that needs to be cheaper:

- Keep `VOICE_STT=auto` (the default). Chrome and Edge transcribe locally for free, so most clients
  never touch the transcription bill.
- Keep the spoken lines short. They already are: the prompt enforces one line under 45 words, and
  the server hard-caps anything the model returns. Speech, not thinking, is what costs.
- `OPENAI_STT_MODEL=gpt-4o-mini-transcribe` if you force server-side transcription.
- `VOICE_MAX_TURNS=30` to bound the worst case.

---

## 5. Troubleshooting

| Symptom | Cause | Fix |
|---|---|---|
| The badge says **Simulated voice** on the live site | The key is not visible to the functions | Add `OPENAI_API_KEY` in Netlify env vars, scoped to Functions, then redeploy |
| "OPENAI_API_KEY was rejected" (401) shown in the call | Wrong or revoked key, or the value has quotes/spaces | Re-paste the key without quotes; the warning is designed to be readable on screen |
| "no credit" / quota (402, 429) | Billing not enabled for that project key | Top up, or set `VOICE_PROVIDER=simulated` so demos keep working |
| The call says the microphone is blocked and typing is on | Browsers block `getUserMedia` inside preview iframes | Open the site in its own browser tab (the mic prompt appears there), or just type |
| No sound, but the AI's line is on screen | The browser blocked autoplay, or the tab is muted | Tap **Hear that again** (the call resumes from there) |
| Long pauses between turns | Model latency plus speech, typically 2 to 4 seconds | Keep `gpt-4o-mini`; the orb and status line show exactly what the call is doing |
| All 12 questions asked but a required field is still "Not stated" | The client skipped those questions | The review screen will not let the blueprint generate until a human fills them in; the "The AI heard ..." button can help |
| Voice works locally but not on Netlify | Body size or timeout | Recordings are capped at 3.5 MB (a few minutes of audio); keep answers to a sentence or two |
| The AI's line appears but nothing is heard on the deployed site | A CSP without `media-src` blocks blob:/data: audio | The repo already sends `media-src 'self' blob: data:` (see `netlify.toml` and `lib/netlify-helpers.js`). If you edit the CSP, keep that directive |
| The call screen is blank inside an embedded preview | Framing headers | Production sends `frame-ancestors 'none'` (correct for your own site). The local dev server is frameless-allowed so it can run in a preview pane; set `PS_ALLOW_FRAMING=0` to make it strict locally too |

---

## 6. Where the code lives

| File | Role |
|---|---|
| `lib/env.js` | Loads `.env` for local runs (no dependency); Netlify supplies its own environment |
| `test/check-openai.js` | `npm run check:openai`: the real-key preflight (key, credit, each model) |
| `lib/voice.js` | The intake plan, the interviewer policy, capture state, the OpenAI adapters, the turn runner |
| `lib/voice-api.js` | The four routes (`session`, `turn`, `transcribe`, `speak`) and the lead-metadata clamp |
| `netlify/functions/voice.js` | The Netlify entry point for `/api/voice/*` (one function) |
| `public/app.js` | The client engine: speaking, listening, one turn, the call screen. Text sits behind "Type instead" |
| `test/voice.js`, `test/voice-openai.js`, `test/ui-smoke.js`, `test/mock-openai.js` | Policy, ChatGPT path, frontend journey, mock endpoint |

Two rules are enforced everywhere and must stay true: **the API key only ever exists server-side**,
and **the whole knowledge base stays server-side**.

---

## 7. Go live, click by click

The live site deploys from `main`, so the voice layer has to reach `main` before Netlify can serve
it. Then it is one environment variable and one redeploy.

### Step A - get the code onto main (5 minutes)

| # | Where | Do this | You should see |
|---|---|---|---|
| A1 | This repo | Open a pull request from `arena/01a0b0bc-ai` to `main` | A PR with the voice layer, already merged with the hardening work |
| A2 | The PR | If Netlify is connected, a **Deploy Preview** link appears on the PR | A working copy of the site with the voice call |
| A3 | The PR | Merge it | `main` moves and Netlify starts a production deploy |
| A4 | Netlify | Deploys -> watch the newest deploy | "Published" |

If your site only builds the production branch, skip to A3: the merge is what production waits for.

### Step B - create the OpenAI key (5 minutes, once)

| # | Where | Do this |
|---|---|---|
| B1 | [platform.openai.com](https://platform.openai.com) | Sign in or sign up. A ChatGPT Plus subscription does **not** fund API calls, it is a separate product |
| B2 | Settings -> **Billing** | Add a payment method and buy the minimum credit (USD 5 is the documented minimum, the default is 10). New API accounts are prepaid |
| B3 | Settings -> **Limits** | Optional: set a monthly budget so a runaway script cannot overspend |
| B4 | Settings -> **API keys**, inside the project you want | **Create new secret key**, name it `pipelinesync-voice`. Copy it once (it starts `sk-`) |
| B5 | Settings -> **Projects** | Confirm the key belongs to the project you expect. Keys are project-scoped |

Never paste the key into a chat, an email, or a file that gets committed. If it leaks, revoke it on
the same screen and create a new one.

### Step C - put the key in Netlify (2 minutes)

| # | Where | Do this |
|---|---|---|
| C1 | Netlify -> your site -> **Site configuration** | Open **Environment variables** |
| C2 | Environment variables | **Add a variable**: key `OPENAI_API_KEY`, value your `sk-...` key. Leave the scopes at their default so **Functions** can read it (a variable scoped to Builds only will not reach the functions) |
| C3 | Same screen | Add `PS_TOKEN_SECRET` if it is not there yet: any long random string (`openssl rand -hex 16`). It signs the login tokens and the voice call tickets |
| C4 | Netlify -> **Deploys** | **Trigger deploy -> Clear cache and deploy site**. Environment changes only reach functions on a new deploy |

Optional, to change how it sounds or what it costs:

| Variable | Example | Effect |
|---|---|---|
| `OPENAI_TTS_VOICE` | `sage` | A different interviewer voice (alloy, ash, ballad, coral, echo, sage, shimmer, verse) |
| `OPENAI_TTS_MODEL` | `gpt-4o-mini-tts` | The speech model (default) |
| `VOICE_TTS_INSTRUCTIONS` | `Speak a little slower and warmer` | Delivery notes for the speech model |
| `OPENAI_STT_MODEL` | `gpt-4o-mini-transcribe` | Cheaper transcription when server-side transcription is forced |
| `VOICE_STT` | `auto` | Keep `auto`: the browser transcribes free whenever it can |
| `VOICE_MAX_TURNS` | `30` | Hard cap per call |

### Step D - prove it is live (2 minutes)

| # | Where | Do this | You should see |
|---|---|---|---|
| D1 | Open your site | Log in, tick the disclaimer, agree | The AI speaks immediately, no text box |
| D2 | The call screen | The badge in the "This call" card | **ChatGPT voice**, not "Simulated voice" |
| D3 | Same card | Read the model line | `gpt-4o-mini-tts`, voice `alloy`, and the transcription model |
| D4 | Finish the call | Answer out loud, then structure the answers | The sidebar captured the fields and the three required numbers are filled |
| D5 | Netlify -> **Functions** -> `voice` -> **Logs** | Watch a turn go past | `[voice] turn 7 mode=openai ...` |
| D6 | Unlock the PDF, then open `/dev/outbox` | Find your lead | A `voice_call` block with provider, models, turns, and `audio_retained: false` |

If D2 says **Simulated voice**, the function cannot see the key: check the scope from C2, then
redeploy as in C4. The line under the badge names the reason.

### Step E - test locally first (optional)

1. Copy `.env.example` to `.env` (gitignored) and put your key in `OPENAI_API_KEY`. The server loads
   `.env` automatically (`lib/env.js`); an existing shell variable still wins.
2. `npm run check:openai` - three tiny real calls (chat, speech, transcription) that confirm the key,
   the credit and each model for well under USD 0.01. Then `node server.js`. The startup log prints `Discovery call voice: openai (chat ..., speech ..., transcription ...)`.
3. Open the app, agree to the disclaimer, and the AI speaks with the OpenAI voice.
4. `node test/voice-openai.js` runs the same journey against a mock endpoint, proving the plumbing
   without spending anything.

### Rolling back

Set `VOICE_PROVIDER=simulated` in Netlify and redeploy: the call still runs end to end, worded by the
built-in interviewer and spoken by the browser voice, with no OpenAI spend. Set it back to `openai`
(or remove the variable) to switch ChatGPT on again.
