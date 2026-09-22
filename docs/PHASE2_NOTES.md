# Phase 2 — Claude-powered PDF generation: timing measurement

## Why generate is a background function

Measured with the four QA personas (`test/personas.json`), the payload Claude has to
produce for Prompt A is the full blueprint document:

| persona | blueprint JSON | approx. output tokens |
|---|---|---|
| solar | 5,290 chars | ~1,470 |
| medical | 5,109 chars | ~1,420 |
| home services | 4,560 chars | ~1,270 |
| ecommerce | 4,446 chars | ~1,235 |

Input is Prompt A (3.4k chars) + the schema + the confirmed fields + the deterministic
reference blueprint, so ~3k input tokens.

At a typical 40–60 output tokens/sec for Sonnet-class models, one clean pass is roughly
25–37s. A schema-validation retry (Phase 2 point 3) doubles that worst case, and a 429/5xx
transport retry adds the backoff on top. That is comfortably over the ~20s bar, and well
over Netlify's 26s synchronous ceiling.

**Decision: generate is asynchronous.**

- `POST /api/generate` re-validates the required fields, creates a job id and returns
  `202 { jobId, pollUrl }`.
- `netlify/functions/generate-background.js` does the work (Netlify runs `*-background`
  functions async, 15 min ceiling) and writes the result to Netlify Blobs
  (`lib/job-store.js`).
- `GET /api/generate/status?jobId=` returns the real step, label and percentage, and the
  blueprint once — and only once — the job is genuinely done.
- The client polls every 2s (`pollGeneration` in `public/app.js`). The old sleep-based
  fake progress animation is gone; the loader renders whatever the server last reported.

Extract (Prompt B) stays synchronous: the output is the 23-field contract, a few hundred
tokens, well inside the `[functions] timeout = 26` set in `netlify.toml`.

## Fallback contract

Every response says which path produced it: `source: "claude" | "fallback"`. Claude output
is parsed *and* validated against `lib/blueprint-schema.js` before anything is rendered;
invalid output is retried once with the validation errors fed back, then the deterministic
knowledge-base v1 logic is used. Malformed output never reaches the PDF writer or the UI.
