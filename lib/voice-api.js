'use strict';
/*
 * PipelineSync AI - voice API routes, shared by the local dev server (server.js) and the
 * Netlify function (netlify/functions/voice.js) so both mounts behave identically.
 *
 * Routes (all POST, all token-authenticated, all server-side):
 *   /api/voice/session     the call plan + which voice provider is live (no key ever leaves)
 *   /api/voice/turn        one interviewer turn: ChatGPT wordings + speech in one round trip
 *   /api/voice/transcribe  audio bytes -> transcript (when the browser cannot transcribe)
 *   /api/voice/speak       text -> speech audio (used by the "Repeat" button)
 *
 * Returns { status, body } so the caller can wrap it for its own hosting style.
 */

const core = require('./core');
const voice = require('./voice');

const MAX_TEXT = 800;

function json(status, body) { return { status, body }; }

/* Bounds on everything a client can send to a voice turn, mirroring the limits the rest of the
   API enforces (lib/netlify-helpers.js validateAnswers) plus the voice-specific payloads. */
const LIMITS = { answers: 20, answerChars: 5000, transcript: 40, transcriptChars: 2000, captures: 60, lastAnswerChars: 4000 };

function validateTurnBody(body) {
  const bad = msg => ({ ok: false, error: msg });
  if (body.answers != null) {
    if (!Array.isArray(body.answers)) return bad('answers must be an array.');
    if (body.answers.length > LIMITS.answers) return bad('Too many answers.');
    for (const a of body.answers) {
      if (!a || typeof a.id !== 'string' || typeof a.text !== 'string') return bad('Invalid answer format.');
      if (a.id.length > 100 || a.text.length > LIMITS.answerChars) return bad('Answer too long (max ' + LIMITS.answerChars + ' chars).');
    }
  }
  if (body.transcript != null) {
    if (!Array.isArray(body.transcript)) return bad('transcript must be an array.');
    if (body.transcript.length > LIMITS.transcript) return bad('Transcript too long.');
    for (const t of body.transcript) {
      if (!t || typeof t.text !== 'string' || (t.role !== 'ai' && t.role !== 'user')) return bad('Invalid transcript entry.');
      if (t.text.length > LIMITS.transcriptChars) return bad('Transcript entry too long.');
    }
  }
  if (Array.isArray(body.voice_captures) && body.voice_captures.length > LIMITS.captures) return bad('Too many captured values.');
  if (body.last_answer != null && String(body.last_answer).length > LIMITS.lastAnswerChars) return bad('That answer is too long to send in one turn.');
  if (body.call_id != null && String(body.call_id).length > 64) return bad('Invalid call id.');
  return { ok: true };
}

function clampVoiceMeta(meta) {
  if (!meta || typeof meta !== 'object') return null;
  const pick = (v, n) => (v == null ? null : String(v).slice(0, n));
  const out = {
    provider: pick(meta.provider, 24),
    mode: pick(meta.mode, 24),
    models: meta.models && typeof meta.models === 'object'
      ? { chat: pick(meta.models.chat, 48), tts: pick(meta.models.tts, 48), stt: pick(meta.models.stt, 48) } : null,
    tts_voice: pick(meta.tts_voice, 32),
    language: pick(meta.language, 12),
    call_id: pick(meta.call_id, 64),
    started_at: pick(meta.started_at, 40),
    ended_at: pick(meta.ended_at, 40),
    duration_s: Number.isFinite(meta.duration_s) ? Math.max(0, Math.round(meta.duration_s)) : null,
    turns: Number.isFinite(meta.turns) ? Math.max(0, Math.round(meta.turns)) : null,
    questions_asked: Array.isArray(meta.questions_asked) ? meta.questions_asked.slice(0, 30).map(q => pick(q, 40)) : [],
    probes: Number.isFinite(meta.probes) ? Math.max(0, Math.round(meta.probes)) : null,
    required_missing_at_call_end: Array.isArray(meta.required_missing_at_call_end) ? meta.required_missing_at_call_end.slice(0, 10).map(q => pick(q, 40)) : [],
    transcript_turns: Number.isFinite(meta.transcript_turns) ? Math.max(0, Math.round(meta.transcript_turns)) : null,
    audio_retained: false
  };
  return out;
}

async function handleVoice(sub, body, opts) {
  const env = (opts && opts.env) || process.env;
  const fetchImpl = (opts && opts.fetchImpl) || globalThis.fetch;
  const cfg = voice.mode(env);

  const payload = core.verifyToken(body && body.token);
  if (!payload) return json(401, { error: 'Not signed in.' });
  const email = payload.email;
  body = body || {};

  /* ---------------- the call plan + who is speaking ---------------- */
  if (sub === 'session') {
    const safeCfg = voice.mode(env);
    return json(200, {
      ok: true,
      plan_version: voice.PLAN_VERSION,
      provider: safeCfg.provider,
      mode: safeCfg.mode,
      why: safeCfg.why,
      models: safeCfg.models,
      tts_voice: safeCfg.voice,
      language: safeCfg.language,
      locale: safeCfg.locale,
      stt_preference: safeCfg.sttPreference,
      max_turns: safeCfg.maxTurns,
      max_audio_bytes: voice.DEFAULTS.maxAudioBytes,
      required_fields: voice.REQUIRED_FIELDS,
      field_labels: voice.FIELD_LABELS,
      plan: voice.INTAKE_PLAN.map(q => ({ id: q.id, label: q.label, ask: q.ask, hint: q.hint, fields: q.fields }))
    });
  }

  /* ---------------- one interviewer turn ---------------- */
  if (sub === 'turn') {
    const valid = validateTurnBody(body);
    if (!valid.ok) return json(400, { ok: false, error: valid.error });
    try {
      const result = await voice.runTurn({
        env, fetchImpl, body, email,
        voiceCaptures: Array.isArray(body.voice_captures) ? body.voice_captures.slice(-60) : []
      });
      return json(200, result);
    } catch (e) {
      if (e && e.status === 429) return json(429, { error: e.message, ok: false });
      // A dead voice provider must not end the call: report it and let the client read the line.
      console.error('[voice] turn failed:', e && e.message);
      return json(502, { ok: false, error: 'The voice service could not answer this turn: ' + (e && e.message || 'unknown error') });
    }
  }

  /* ---------------- speech to text ---------------- */
  if (sub === 'transcribe') {
    const b64 = String(body.audio_base64 || '');
    if (!b64) return json(400, { error: 'No audio in the request.' });
    const approxBytes = Math.floor(b64.length * 0.75);
    if (approxBytes > voice.DEFAULTS.maxAudioBytes) {
      return json(413, { error: 'That recording is too long to upload (' + Math.round(approxBytes / 1024) + ' KB). Answer in one or two sentences, or type instead.' });
    }
    if (cfg.provider !== 'openai') {
      return json(200, { ok: true, text: '', provider: 'simulated', note: 'No OPENAI_API_KEY is set, so server-side transcription is off. Use the browser microphone or type instead.' });
    }
    try {
      const out = await voice.transcribe({
        apiKey: String(env.OPENAI_API_KEY || '').trim(),
        model: cfg.models.stt,
        baseUrl: cfg.baseUrl,
        fetchImpl,
        buffer: Buffer.from(b64, 'base64'),
        mime: String(body.mime || 'audio/webm').slice(0, 60),
        language: cfg.language,
        prompt: 'A business owner describing their company, products, prices in Philippine pesos, marketing lead sources, close rate, and CRM tools.',
        timeoutMs: cfg.timeoutMs
      });
      return json(200, { ok: true, text: out.text, provider: 'openai', model: cfg.models.stt, usage: out.usage, latency_ms: 0 });
    } catch (e) {
      console.error('[voice] transcribe failed:', e && e.message);
      return json(502, { ok: false, error: e.message });
    }
  }

  /* ---------------- text to speech (Repeat, and the closing line) ---------------- */
  if (sub === 'speak') {
    const text = voice.spokenStyle(body.text, MAX_TEXT);
    if (!text) return json(400, { error: 'Nothing to speak.' });
    if (cfg.provider !== 'openai') {
      return json(200, { ok: true, audio_base64: null, speak_with_browser: true, provider: 'simulated', text, why: cfg.why });
    }
    try {
      const out = await voice.synthesize({
        apiKey: String(env.OPENAI_API_KEY || '').trim(),
        model: cfg.models.tts, voice: body.voice && /^[a-z0-9-]{3,24}$/.test(body.voice) ? body.voice : cfg.voice,
        baseUrl: cfg.baseUrl, fetchImpl, text, instructions: cfg.ttsInstructions, speed: 1, timeoutMs: cfg.timeoutMs
      });
      return json(200, { ok: true, audio_base64: out.audio.toString('base64'), audio_mime: out.mime, provider: 'openai', model: cfg.models.tts, text });
    } catch (e) {
      console.error('[voice] speak failed:', e && e.message);
      return json(502, { ok: false, error: e.message, speak_with_browser: true, text });
    }
  }

  return json(404, { error: 'Unknown voice route' });
}

module.exports = { handleVoice, clampVoiceMeta, validateTurnBody, LIMITS };
