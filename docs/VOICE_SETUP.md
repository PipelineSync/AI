# Voice setup: ChatGPT takes over the discovery call

This is the operator guide for the voice layer. It covers what the layer does, the one thing you
must set in Netlify, how to verify it is really ChatGPT talking, what it costs, and what to do when
something misbehaves.

---

## 1. What actually happens on a discovery call

The call is **continuous voice**: one WebRTC session (the OpenAI Realtime API) carries the whole
discovery call, from the first word to the last. Nothing is recorded, uploaded, transcribed and
replayed between questions, so the client is never cut off mid-answer.

```
                 ┌──────────── one WebRTC session, open for the whole call ───────────┐
 client speaks ──►                                                                    ──► AI speaks
                 └────────────────────────────────────────────────────────────────────┘
                       each answer the model heard ──► /api/voice/realtime/tool
                                                       (the guardrail set decides what is
                                                        saved and which question comes next)
```

1. **The AI speaks first, the moment the disclaimer is agreed.** Agreeing to the AI disclaimer and
   privacy notice is the click that starts the call. The client opens the microphone once, asks the
   server to open a live session (`POST /api/voice/realtime/connect`, which forwards the browser's
   SDP offer to OpenAI and returns the answer), and the AI's voice starts inside that click. There
   is no second start button and no text box. The API key stays in the function: the browser only
   ever sees an SDP answer.
2. **The client talks, and keeps talking.** Turn detection is `semantic_vad`: the model decides when
   the client has finished a thought rather than cutting on a fixed silence, so a two-sentence
   answer arrives whole. The client can talk over the AI at any point (barge-in) and the AI stops.
3. **The guardrail set still decides the content.** The 12 intake questions live in `lib/voice.js`
   (`INTAKE_PLAN`). After each answer the model calls `record_answer`, and the server answers with
   the exact next question to ask (a question, a probe, or the closing summary). The model words it,
   it does not choose it: it cannot wander off the intake set, cannot skip a question the blueprint
   needs, and cannot invent a figure.
4. **Alex answers the client's own questions before moving on.** "What is PipelineSync?", "How much
   does it cost?", "Are you an AI?", "What happens to my data?", "What happens next?" all have a
   scripted answer (`REALTIME_FAQ` in `lib/voice.js`) that is short, honest and invents no number.
   The rule is answer in one or two sentences, then return to the intake set. The client's question
   is never captured as an answer, and a question that was answered is not asked again.
5. **Every captured value must be grounded in words the client actually said.** The model reports a
   `quote` with each value; the server re-checks it (`validateCaptures`): the field must be real, the
   value must not be filler, every number in the value must have been heard in that turn, and the
   quoted words must actually support the value. Figures shown as on-screen examples can never be
   captured, because the instructions never contain them. Refused values are counted and reported,
   and an off-topic turn (background TV, someone else talking) saves nothing and re-asks the
   question once.
6. **Three required fields must land:** typical deal size, monthly lead volume, close rate. `end_call`
   is refused while one of them is still missing and unasked; if the client declines or skips, the
   review screen blocks generation until a human fills them in. Nothing is ever invented.
7. **No audio is kept.** The session stores transcripts only; the lead carries
   `"audio_retained": false`.

### The fallback: the same call, step by step

If the browser cannot do WebRTC, the microphone is blocked (browsers block `getUserMedia` inside
preview iframes), there is no key, or OpenAI refuses the session, the client runs the same call on
the turn-based pipeline. Nothing is lost: a session that dies mid-call keeps every answer and every
capture already recorded and carries on from the next question.

```
                 microphone                OpenAI                    OpenAI
 client speaks ──────────────► transcript ─────────► next line ─────────────► audio
                 (browser or /transcribe)   (/voice/turn, guardrail set)   (/voice/speech)
```

In that mode the browser transcribes free of charge when it can (`SpeechRecognition`); otherwise the
recording is uploaded to OpenAI transcription (`/api/voice/transcribe`). The mic stops itself once it
hears a pause. Everything else - the guardrail set, the FAQ answers, the grounded-capture rules, the
three required fields - is identical, because it is the same server code.

To turn the continuous call off everywhere without a deploy, set `VOICE_REALTIME=off`. To keep the
built-in interviewer and the browser voice (no OpenAI spend at all), set `VOICE_PROVIDER=simulated`.

---

## 2. Turn it on

The only required setting is the OpenAI key. It is read **inside** the serverless functions, so it
never reaches the browser.

### Netlify (the live site)

1. Netlify dashboard → your site → **Site configuration → Environment variables → Add a variable**.
2. Add `OPENAI_API_KEY` = your key (`sk-...`). Keep the scope to Functions (the default is fine).
3. Add `PS_TOKEN_SECRET` if you have not already (any long random string) so entry-gate tokens and voice
   call tickets are signed with your own secret.
4. **Deploys → Trigger deploy → Deploy site.** Environment changes need a redeploy for functions to
   pick them up.
5. Optional, same screen (defaults shown; see section 4 for when to change them):

   | Variable | Default | What it does |
   |---|---|---|
   | `VOICE_PROVIDER` | `openai` when the key is set | Set to `simulated` to force the built-in interviewer even with a key |
   | `VOICE_REALTIME` | on when the key is set | Set to `off` to force the step-by-step call everywhere (the emergency switch for the continuous call) |
   | `OPENAI_REALTIME_MODEL` | `gpt-realtime-2.1` | The continuous-call model. Fallbacks if the account rejects it: `gpt-realtime`, `gpt-realtime-2` |
   | `OPENAI_REALTIME_VOICE` | `marin` | The voice on a continuous call (`marin`, `alloy`, `cedar`, ...). Fallback: `alloy` |
   | `OPENAI_REALTIME_VAD` | `semantic_vad` | `semantic_vad` waits for the thought to finish; `server_vad` cuts on a fixed silence |
   | `OPENAI_REALTIME_EAGERNESS` | `medium` | How quickly the model takes the turn back: `low`, `medium`, `high`, `auto` |
   | `OPENAI_REALTIME_SILENCE_MS` | `700` | `server_vad` only: the silence window before the turn ends |
   | `OPENAI_REALTIME_VAD_THRESHOLD` | `0.5` | `server_vad` only: how loud speech must be to count |
   | `OPENAI_REALTIME_MAX_MIN` | `15` | Spend guard: the session is closed politely at this point |
   | `OPENAI_REALTIME_MAX_TOOLS` | `90` | Spend guard: tool calls per call before the server hangs up |
   | `OPENAI_CHAT_MODEL` | `gpt-4o-mini` | The turn brain (words each line on the step-by-step call) |
   | `OPENAI_TTS_MODEL` | `gpt-4o-mini-tts` | The voice the client hears on the step-by-step call |
   | `OPENAI_TTS_VOICE` | `alloy` | alloy, ash, ballad, coral, echo, sage, shimmer, verse |
   | `OPENAI_STT_MODEL` | `gpt-4o-transcribe` | Transcription: the browser's own engine first, this when it cannot |
   | `VOICE_STT` | `auto` | `auto` (browser first), `browser`, or `openai` (always upload) |
   | `VOICE_LANGUAGE` | `en` | Language code sent to the transcription model |
   | `VOICE_LOCALE` | `en-PH` | Locale for the browser microphone |
   | `VOICE_MAX_TURNS` | `40` | Spend guard: a runaway step-by-step call is refused before it costs anything |
   | `OPENAI_BASE_URL` | `https://api.openai.com/v1` | For a gateway, an Azure-compatible endpoint, or a mock |

   The continuous call needs no extra key and no extra product: the same `OPENAI_API_KEY` is used,
   and the session is opened by the function (`POST /v1/realtime/calls` with the browser's SDP), so
   the key never reaches the browser and no ephemeral token has to be issued to the client.

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

```
Discovery call voice: openai (chat gpt-4o-mini, speech gpt-4o-mini-tts voice alloy, transcription gpt-4o-transcribe)
Continuous call: OpenAI Realtime gpt-realtime-2.1 voice marin (semantic_vad, eagerness medium) - one WebRTC session carries the whole call
```

A real browser needs the real OpenAI endpoint for the continuous call: the mock returns a stub SDP
answer, so a browser pointed at it fails the handshake and drops to the step-by-step call (which is
exactly the fallback working). The continuous path itself is covered end to end by
`node test/voice-realtime.js`, which drives a fake WebRTC peer connection and a fake model in jsdom
against the mock endpoint - a whole twelve-question call over one session, with no OpenAI spend.

---

## 3. Verify it is really the live call

1. **On screen.** The call panel shows a badge: **Live AI voice** on a continuous call (with the
   realtime model, the voice and the turn detection underneath, plus how many values were accepted
   and refused), **ChatGPT voice** on the step-by-step call, **Simulated voice** with no key. The
   sidebar also lists the models in use, and the call controls change to *Mute mic*, *Hear that
   again*, *Mute the AI*, *Type instead* and *End the call*.
2. **In the function logs.** Netlify → Functions → `voice`. A continuous call logs one line when the
   session opens and one per answer:

   ```
   [voice] realtime session opened: model=gpt-realtime-2.1 voice=marin vad=semantic_vad call=rt-8f3a...
   [voice] realtime tool 7 q=volumes quality=complete accepted=2 rejected=0 next=close_rate/question captured=18/23 missing_required=[]
   [voice] realtime call ended: turns=12 captured=23/23 skipped=0 missing_required=[] audio_retained=false
   ```

   `accepted`/`rejected` are the grounded-capture counts: a rejected value was claimed by the model
   and refused by the server because the client never said it. On the step-by-step call the line is
   `[voice] turn 7 mode=openai ask=volumes kind=question captured=18/23 ...`.
3. **On the lead.** After the PDF is unlocked the lead in `/dev/outbox` (or the Netlify function
   logs for `deliver`) carries a `voice_call` block: provider, models, voice, turns, which questions
   were asked, how many probes, whether the three required fields were still missing at the end, and
   `"audio_retained": false`. A continuous call adds `transport: "webrtc"`, `realtime_model`,
   `realtime_voice`, `turn_detection`, `tool_calls`, `captures_accepted`, `captures_rejected` and
   `fallback_to_turns` (true only if the live session died and the call carried on step by step).
4. **Automated.** `node test/voice-realtime.js` runs a whole continuous call in jsdom against a fake
   WebRTC peer connection and the bundled mock endpoint: it asserts one session and one microphone
   for the whole call, semantic turn detection, the FAQ and answering rules in the session
   instructions, the grounded-capture gate, the twelve questions in order, and the fallback when
   WebRTC is missing. `node test/voice-openai.js` covers the step-by-step ChatGPT path,
   `node test/voice.js` the guardrail policy and the routes, and `node test/ui-smoke.js` the real
   frontend journey. `npm run test:all` runs all of them.

---

## 4. Cost

Prices move, so treat everything here as order-of-magnitude and check the OpenAI pricing page before
budgeting.

### The continuous call (the default)

Realtime is billed by audio token, not by minute: roughly 600 tokens per minute of client speech
heard and 1,200 per minute of AI speech, at USD 32 per million audio input tokens (USD 0.40 when
cached, which most of the session prompt is) and USD 64 per million audio output tokens on
`gpt-realtime-2.1`.

| Part | Rate | A 4-minute call |
|---|---|---|
| Client speech heard | ~USD 0.019 per minute | ~USD 0.05 (far less with caching) |
| AI speech (the bulk) | ~USD 0.077 per minute of speech | ~USD 0.15 to 0.25 |
| Input transcription | billed per minute of audio | ~USD 0.02 |
| | | **~USD 0.20 to 0.35 per completed discovery call** |

Knobs if that needs to be cheaper:

- `OPENAI_REALTIME_MODEL=gpt-realtime-2.1-mini` (where your account has it) is about a third of the
  audio price and is plenty for a scripted intake call.
- Keep the instructions and the questions short: they are re-sent with the session, and cached input
  is 80x cheaper than fresh input.
- `OPENAI_REALTIME_EAGERNESS=low` makes the model wait longer before taking the turn back, which
  costs a little more in heard audio but stops it talking over a slow client.
- `OPENAI_REALTIME_MAX_MIN=10` and `OPENAI_REALTIME_MAX_TOOLS=60` bound the worst case; the call is
  closed politely at the limit with everything captured so far.

### The step-by-step call (the fallback, or `VOICE_REALTIME=off`)

| Part | Model | Typical cost per call (about 15 turns, 3 to 5 minutes of speech) |
|---|---|---|
| Turn wording | `gpt-4o-mini` | under USD 0.01 |
| Speech out (the bulk) | `gpt-4o-mini-tts` | ~USD 0.05 |
| Transcription in | `gpt-4o-transcribe` | ~USD 0.02, **zero** when the browser transcribes |
| | | **~USD 0.06 with browser transcription, ~USD 0.08 without** |

Knobs: keep `VOICE_STT=auto` so Chrome and Edge transcribe locally for free; keep the spoken lines
short (the prompt enforces one line under 45 words and the server hard-caps anything longer);
`OPENAI_STT_MODEL=gpt-4o-mini-transcribe` if you force server-side transcription; `VOICE_MAX_TURNS=30`
to bound the worst case.

---

## 5. Troubleshooting

| Symptom | Cause | Fix |
|---|---|---|
| The notice says "The continuous voice call could not start (...)" and the call carries on step by step | The browser has no WebRTC, the microphone is blocked (preview iframes), or OpenAI refused the session | Read the reason in the notice. `mic-blocked`: open the site in its own tab. `not-available`: an old or locked-down browser; the step-by-step call is the same call. Anything else: check the key and the function logs |
| The badge says **ChatGPT voice** on a browser you expected to be live | `VOICE_REALTIME=off`, or `VOICE_PROVIDER=simulated`, or the session could not be opened | Remove `VOICE_REALTIME` (or set it to anything but `off`) and redeploy; the startup log line `Continuous call:` says which one it is |
| No audio at all on a live call, but the transcript moves | The browser blocked autoplay of the remote audio track | Any tap on the page releases it; the **Hear that again** button repeats the last question |
| The AI cuts in before the client finishes a sentence | Turn detection is taking the turn back too eagerly | `OPENAI_REALTIME_EAGERNESS=low` (semantic VAD), or raise `OPENAI_REALTIME_SILENCE_MS` if you switched to `server_vad` |
| The AI talks over the client, or the client cannot interrupt | Barge-in is on by default (`interrupt_response: true`); a dead session looks the same | Check the function logs for `[voice] realtime session opened`; if the session died the client says so and carries on step by step |
| Values the client clearly said are missing from the sidebar | The grounded-capture gate refused them: the model quoted words that do not support the value, or the number was never heard | This is the guardrail working. `[voice] realtime tool ... rejected=N` counts them, and the review screen shows "The AI heard ..." so a human can add them |
| A field the client never mentioned appears on the review screen | It cannot come from the live call: captures need a quote that supports the value | If it does appear, the answer text is still saved for Function A; report it, because the parser (not the model) filled it |
| The call ends on its own after about 15 minutes | The spend guard | `OPENAI_REALTIME_MAX_MIN` (the client is told the call is wrapping up first, and everything captured is kept) |
| The model name is rejected (404) on a new account | Realtime model names change | The server already retries `gpt-realtime-2.1` -> `gpt-realtime` -> `gpt-realtime-2`; set `OPENAI_REALTIME_MODEL` to the name your account has |
| WebRTC never connects on a corporate network | Egress firewall or no TURN path | Nothing to fix in code: the client falls back to the step-by-step call, and the lead records `fallback_to_turns: true` |
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
| `lib/voice.js` | The intake plan, the interviewer policy, capture state, the grounded-capture gate (`validateCaptures`), the FAQ (`REALTIME_FAQ`), the OpenAI adapters, the turn runner, and the continuous-call engine (`realtimeSessionConfig`, `connectRealtime`, `realtimeGuidance`, `runRealtimeTool`, `endRealtimeCall`) |
| `lib/voice-api.js` | The routes (`session`, `turn`, `transcribe`, `speak`, `realtime/connect`, `realtime/tool`, `realtime/end`), their rate limits, and the lead-metadata clamp |
| `lib/core.js` | Function A: the deterministic parser, including the spoken-number normaliser (`normalizeSpokenNumbers`) that turns "one and a half million" into 1500000 |
| `netlify/functions/voice.js` | The Netlify entry point for `/api/voice/*` (one function) |
| `public/app.js` | Both client engines: the continuous call (one WebRTC session, one data channel, live transcript, mute/repeat/type controls) and the step-by-step call. Text sits behind "Type instead" |
| `test/voice-realtime.js` | A whole continuous call in jsdom: fake WebRTC, fake model, mock endpoint |
| `test/voice.js`, `test/voice-openai.js`, `test/ui-smoke.js`, `test/mock-openai.js` | Policy, step-by-step ChatGPT path, frontend journey, mock endpoint (chat, speech, transcription and `/v1/realtime/calls`) |

Two rules are enforced everywhere and must stay true: **the API key only ever exists server-side**,
and **the whole knowledge base stays server-side**.

---

## 7. Go live, click by click

The live site deploys from `main`, so the voice layer has to reach `main` before Netlify can serve
it. Then it is one environment variable and one redeploy.

### Step A - get the code onto main (5 minutes)

| # | Where | Do this | You should see |
|---|---|---|---|
| A1 | This repo | Open a pull request from `arena/01a0b1a3-ai` to `main` | A PR with the continuous voice call, already merged with the hardening work |
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
| C3 | Same screen | Add `PS_TOKEN_SECRET` if it is not there yet: any long random string (`openssl rand -hex 16`). It signs the entry-gate session tokens and the voice call tickets |
| C4 | Netlify -> **Deploys** | **Trigger deploy -> Clear cache and deploy site**. Environment changes only reach functions on a new deploy |

Optional, to change how it sounds or what it costs:

| Variable | Example | Effect |
|---|---|---|
| `OPENAI_REALTIME_VOICE` | `cedar` | A different voice on the continuous call (`marin` is the default, `alloy` the fallback) |
| `OPENAI_REALTIME_MODEL` | `gpt-realtime-2.1-mini` | A cheaper continuous-call model, where your account has it |
| `OPENAI_REALTIME_EAGERNESS` | `low` | The model waits longer before taking the turn back |
| `VOICE_REALTIME` | `off` | Force the step-by-step call everywhere (the emergency switch) |
| `OPENAI_TTS_VOICE` | `sage` | A different interviewer voice on the step-by-step call (alloy, ash, ballad, coral, echo, sage, shimmer, verse) |
| `OPENAI_TTS_MODEL` | `gpt-4o-mini-tts` | The speech model (default) |
| `VOICE_TTS_INSTRUCTIONS` | `Speak a little slower and warmer` | Delivery notes for the speech model |
| `OPENAI_STT_MODEL` | `gpt-4o-mini-transcribe` | Cheaper transcription when server-side transcription is forced |
| `VOICE_STT` | `auto` | Keep `auto`: the browser transcribes free whenever it can |
| `VOICE_MAX_TURNS` | `30` | Hard cap per call |

### Step D - prove it is live (2 minutes)

| # | Where | Do this | You should see |
|---|---|---|---|
| D1 | Open your site **in its own browser tab** (not an embedded preview) | Enter your name and email, tick the disclaimer, agree | The AI speaks immediately, no text box, and the call does not stop between questions |
| D2 | The call screen | The badge in the "This call" card | **Live AI voice**, not "ChatGPT voice" and not "Simulated voice" |
| D3 | Same card | Read the model line | the realtime model (`gpt-realtime-2.1`), the voice (`marin`) and the turn detection (`semantic_vad`) |
| D4 | Mid-call | Ask "Are you an AI?" or "How much does it cost?" | Alex answers honestly in a sentence or two, then returns to the intake question |
| D5 | Mid-call | Talk over the AI | It stops and lets you finish (barge-in) |
| D6 | Finish the call | Answer out loud, then structure the answers | The sidebar captured the fields and the three required numbers are filled |
| D7 | Netlify -> **Functions** -> `voice` -> **Logs** | Watch the call go past | `[voice] realtime session opened: ...` then one `[voice] realtime tool ...` line per answer |
| D8 | Unlock the PDF, then open `/dev/outbox` | Find your lead | A `voice_call` block with `transport: "webrtc"`, the realtime model and voice, `captures_accepted`, `captures_rejected`, `fallback_to_turns: false`, and `audio_retained: false` |

If D2 says **ChatGPT voice**, the continuous call could not be opened: the notice on the call screen
names the reason (a blocked microphone inside an iframe is the common one - use its own tab). If it
says **Simulated voice**, the function cannot see the key: check the scope from C2, then redeploy as
in C4.

### Step E - test locally first (optional)

1. Copy `.env.example` to `.env` (gitignored) and put your key in `OPENAI_API_KEY`.
2. `node server.js`. The startup log prints `Discovery call voice: openai (...)` and
   `Continuous call: OpenAI Realtime gpt-realtime-2.1 voice marin (...)`.
3. Open the app **in its own tab** (a preview iframe blocks the microphone), agree to the
   disclaimer, and the AI speaks with the OpenAI voice in one continuous session.
4. `node test/voice-realtime.js` runs a whole continuous call against a fake WebRTC peer connection
   and the mock endpoint, and `node test/voice-openai.js` runs the step-by-step journey the same way.
   Neither spends anything.

### Rolling back

Three levels, all environment variables, all needing only a redeploy:

| Set this | Effect |
|---|---|
| `VOICE_REALTIME=off` | The continuous call is off; the same call runs step by step with ChatGPT wording and OpenAI speech. Use this if the realtime model misbehaves or the bill matters more than the flow |
| `VOICE_PROVIDER=simulated` | No OpenAI at all: the built-in interviewer words the questions and the browser voice speaks them, with zero spend |
| (remove both) | Back to the continuous call |

Whatever runs, the guardrail set, the grounded-capture gate and the three required fields are the
same server code, so a rollback never changes what is captured - only how the call sounds.
