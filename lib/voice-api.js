'use strict';
/*
 * PipelineSync AI - voice API routes, shared by the local dev server (server.js) and the
 * Netlify function (netlify/functions/voice.js) so both mounts behave identically.
 *
 * Routes (all POST, all token-authenticated, all server-side):
 *   /api/voice/session           the call plan + which voice provider is live (no key ever leaves)
 *   /api/voice/turn              one interviewer turn: ChatGPT wordings + speech in one round trip
 *   /api/voice/transcribe        audio bytes -> transcript (when the browser cannot transcribe)
 *   /api/voice/speak             text -> speech audio (used by the "Repeat" button)
 *
 *   The continuous call (OpenAI Realtime over WebRTC) adds three:
 *   /api/voice/realtime/connect  the browser's SDP offer -> the session SDP answer. The server owns
 *                                the session config (instructions, tools, voice, turn detection) and
 *                                the API key, so neither can be changed or read from the browser.
 *   /api/voice/realtime/tool     one tool call from the live session (record_answer / end_call):
 *                                the guardrail set validates what was heard and returns the next
 *                                question the model is allowed to ask.
 *   /api/voice/realtime/end      the call is over: the final contract state for the review screen.
 *
 * Returns { status, body } so the caller can wrap it for its own hosting style.
 */

const core = require('./core');
const voice = require('./voice');

const MAX_TEXT = 800;

function json(status, body) { return { status, body }; }

/* Per-route spend and abuse limits (requests per minute per IP), shared by the local dev server and
   the Netlify function so both mounts behave identically. The continuous call posts one tool call
   per answer, which is far more frequent than a step-by-step turn, so it gets its own ceiling. */
const RATE_PER_MIN = { turn: 40, session: 30, transcribe: 30, speak: 30, 'realtime/connect': 12, 'realtime/tool': 120, 'realtime/end': 30 };
function rateLimitFor(sub) { return RATE_PER_MIN[sub] || 30; }

/* Bounds on everything a client can send to a voice turn, mirroring the limits the rest of the
   API enforces (lib/netlify-helpers.js validateAnswers) plus the voice-specific payloads. */
const LIMITS = { answers: 20, answerChars: 5000, transcript: 40, transcriptChars: 2000, captures: 60, lastAnswerChars: 4000, sdpChars: 64000, toolLines: 8 };

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

function validateRealtimeBody(sub, body) {
  const bad = msg => ({ ok: false, error: msg });
  if (body.call_id != null && String(body.call_id).length > 64) return bad('Invalid call id.');
  const base = validateTurnBody(body);
  if (!base.ok) return base;
  if (sub === 'connect') {
    const sdp = String(body.sdp || '');
    if (!sdp) return bad('No WebRTC offer in the request.');
    if (sdp.length > LIMITS.sdpChars) return bad('That WebRTC offer is too large.');
    if (!/v=0/i.test(sdp)) return bad('That is not a WebRTC offer. Start the call again.');
  }
  if (sub === 'tool') {
    if (!/^[a-z_]{3,32}$/.test(String(body.name || ''))) return bad('Unknown tool name.');
    if (String(body.arguments == null ? '' : (typeof body.arguments === 'string' ? body.arguments : JSON.stringify(body.arguments))).length > 20000) return bad('That tool call is too large.');
    if (body.user_turn != null && String(body.user_turn).length > LIMITS.lastAnswerChars) return bad('That transcript line is too long.');
    for (const k of ['user_lines', 'ai_lines']) {
      if (body[k] != null) {
        if (!Array.isArray(body[k]) || body[k].length > LIMITS.toolLines) return bad(k + ' must be a short array.');
        if (body[k].some(x => String(x || '').length > LIMITS.transcriptChars)) return bad(k + ' entries are too long.');
      }
    }
  }
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
    // Continuous call: how it was held, and how much the model claimed that did not survive grounding.
    transport: pick(meta.transport, 24),
    realtime_model: pick(meta.realtime_model, 48),
    realtime_voice: pick(meta.realtime_voice, 32),
    turn_detection: pick(meta.turn_detection, 24),
    tool_calls: Number.isFinite(meta.tool_calls) ? Math.max(0, Math.round(meta.tool_calls)) : null,
    captures_accepted: Number.isFinite(meta.captures_accepted) ? Math.max(0, Math.round(meta.captures_accepted)) : null,
    captures_rejected: Number.isFinite(meta.captures_rejected) ? Math.max(0, Math.round(meta.captures_rejected)) : null,
    fallback_to_turns: meta.fallback_to_turns === true,
    audio_retained: false
  };
  return out;
}

async function handleVoice(sub, body, opts) {
  const env = (opts && opts.env) || process.env;
  const fetchImpl = (opts && opts.fetchImpl) || globalThis.fetch;
  const cfg = voice.mode(env);

  const payload = core.verifyToken(body && body.token);
  if (!payload) return json(401, { error: 'Your session has ended. Enter your name and email to start again.' });
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
      realtime: {
        enabled: safeCfg.realtime.enabled,
        why: safeCfg.realtime.why,
        model: safeCfg.realtime.model,
        voice: safeCfg.realtime.voice,
        turn_detection: safeCfg.realtime.vad,
        eagerness: safeCfg.realtime.eagerness,
        max_session_min: safeCfg.realtime.maxSessionMin,
        connect_route: '/api/voice/realtime/connect',
        tool_route: '/api/voice/realtime/tool',
        end_route: '/api/voice/realtime/end'
      },
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

  /* ---------------- continuous call: open the session ---------------- */
  if (sub === 'realtime/connect') {
    const valid = validateRealtimeBody('connect', body);
    if (!valid.ok) return json(400, { ok: false, error: valid.error });
    if (!cfg.realtime.enabled) {
      return json(200, { ok: false, fallback: 'turns', error: cfg.realtime.why });
    }
    try {
      const out = await voice.connectRealtime({
        env, fetchImpl, cfg, sdp: String(body.sdp || ''),
        timeoutMs: cfg.timeoutMs,
        ctx: {
          clientName: String(body.client_name || '').slice(0, 80),
          asked: Array.isArray(body.asked) ? body.asked : [],
          capture: voice.captureState(Array.isArray(body.answers) ? body.answers : [], Array.isArray(body.voice_captures) ? body.voice_captures.filter(c => c && c.grounded) : [])
        }
      });
      const callId = String(body.call_id || '').slice(0, 64) || 'call-' + Date.now().toString(36);
      // The opening is chosen by the guardrail set, not by the model: it is the first thing the
      // client asks the session to say once the data channel is open.
      const step = voice.nextStep({
        answers: Array.isArray(body.answers) ? body.answers : [],
        asked: Array.isArray(body.asked) ? body.asked : [],
        probes: {}, skipped: Array.isArray(body.skipped) ? body.skipped : [], voiceCaptures: []
      });
      console.log('[voice] realtime session opened: model=' + out.model + ' voice=' + out.voice +
        ' vad=' + cfg.realtime.vad + ' call=' + callId + (out.attempts && out.attempts.length ? ' attempts=' + out.attempts.length : ''));
      return json(200, {
        ok: true, sdp: out.sdp, model: out.model, voice: out.voice,
        provider: 'openai-realtime', mode: 'realtime',
        turn_detection: cfg.realtime.vad,
        max_session_min: cfg.realtime.maxSessionMin,
        call_id: callId,
        call_ticket: voice.issueRealtimeTicket(email, callId, 0, 0),
        opening: step.question
          ? { kind: step.kind, question_id: step.question.id, ask_now: step.spoken, instruction: 'Open the call and ask question 1 now.' }
          : { kind: 'done', question_id: null, ask_now: null, instruction: 'Close the call.' },
        attempts: out.attempts || [],
        warnings: (out.attempts && out.attempts.length > 1) ? ['The first realtime model was not available, so ' + out.model + ' was used.'] : []
      });
    } catch (e) {
      console.error('[voice] realtime connect failed:', e && e.message);
      // Never end the call: the client falls back to the step-by-step path on this response.
      return json(200, { ok: false, fallback: 'turns', error: (e && e.message) || 'The continuous voice session could not be opened.' });
    }
  }

  /* ---------------- continuous call: one tool call ---------------- */
  if (sub === 'realtime/tool') {
    const valid = validateRealtimeBody('tool', body);
    if (!valid.ok) return json(400, { ok: false, error: valid.error });
    try {
      const out = voice.runRealtimeTool({ env, body, email });
      return json(200, out);
    } catch (e) {
      console.error('[voice] realtime tool failed:', e && e.message);
      return json(200, {
        ok: false, name: String(body.name || ''), error: (e && e.message) || 'tool error',
        output: { error: 'That could not be saved. Carry on with the next question on the intake set.', instruction: 'Carry on with the intake set.' }
      });
    }
  }

  /* ---------------- continuous call: hang up ---------------- */
  if (sub === 'realtime/end') {
    const valid = validateTurnBody(body);
    if (!valid.ok) return json(400, { ok: false, error: valid.error });
    const out = voice.endRealtimeCall({ env, body });
    return json(200, out);
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

module.exports = { handleVoice, clampVoiceMeta, validateTurnBody, validateRealtimeBody, rateLimitFor, RATE_PER_MIN, LIMITS };
