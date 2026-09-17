'use strict';
/*
 * Preflight for the real OpenAI key: `npm run check:openai`
 *
 * Makes three deliberately tiny REAL calls against the models the voice layer uses:
 *   1. chat        (gpt-4o-mini)        - a few tokens
 *   2. speech      (gpt-4o-mini-tts)    - six words
 *   3. transcription (gpt-4o-transcribe)- transcribes the clip from step 2
 * Total spend is well under USD 0.01, so it is safe on a USD 5 balance.
 * Add --no-stt to skip step 3, or --chat-only for step 1 alone.
 *
 * It reports, in plain language: key present, key valid, credit available, each model usable.
 */
require('../lib/env').load();
const voice = require('../lib/voice');

const args = process.argv.slice(2);
const chatOnly = args.includes('--chat-only');
const noStt = chatOnly || args.includes('--no-stt');

const env = process.env;
const cfg = voice.mode(env);
const key = String(env.OPENAI_API_KEY || '').trim();
const base = String(env.OPENAI_BASE_URL || 'https://api.openai.com/v1').replace(/\/+$/, '');

const results = [];
function record(name, ok, detail) {
  results.push({ name, ok, detail });
  console.log((ok ? '  PASS  ' : '  FAIL  ') + name + (detail ? ' - ' + detail : ''));
}

function explain(status, body) {
  if (status === 401) return 'the key was rejected (wrong, revoked, or pasted with quotes/spaces)';
  if (status === 402 || status === 429) {
    if (/quota|billing|credit/i.test(body)) return 'no credit on this project: add funds at platform.openai.com -> Billing';
    return 'rate limited - wait a moment and re-run';
  }
  if (status === 404) return 'this model is not available to your project';
  if (status === 403) return 'your project is not allowed to use this model or region';
  return 'HTTP ' + status + ' ' + body.slice(0, 200);
}

async function main() {
  console.log('OpenAI preflight for the discovery call voice layer');
  console.log('  endpoint: ' + base);
  console.log('  models:   chat ' + cfg.models.chat + ', speech ' + cfg.models.tts + ' (voice ' + cfg.voice + '), transcription ' + cfg.models.stt);
  console.log('');

  if (!key) {
    console.log('  FAIL  OPENAI_API_KEY is set');
    console.log('');
    console.log('Nothing to test. Put your key in .env (copy .env.example) or run:');
    console.log('  OPENAI_API_KEY=sk-... npm run check:openai');
    process.exit(1);
  }
  record('OPENAI_API_KEY is set', true, key.slice(0, 7) + '... (' + key.length + ' chars)');
  if (/^["']|["']$/.test(env.OPENAI_API_KEY || '')) {
    record('key has no stray quotes', false, 'remove the surrounding quotes from the value');
  }
  if (cfg.mode !== 'openai') {
    record('voice provider resolves to openai', false, cfg.why);
  }

  const auth = { Authorization: 'Bearer ' + key };

  // 1. chat
  let chatOk = false;
  try {
    const r = await fetch(base + '/chat/completions', {
      method: 'POST',
      headers: { ...auth, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: cfg.models.chat,
        max_tokens: 5,
        messages: [{ role: 'user', content: 'Reply with the single word: ready' }]
      })
    });
    const text = await r.text();
    if (!r.ok) record('chat model ' + cfg.models.chat, false, explain(r.status, text));
    else {
      const j = JSON.parse(text);
      chatOk = true;
      record('chat model ' + cfg.models.chat, true, 'replied "' + String(j.choices?.[0]?.message?.content || '').trim() + '"');
    }
  } catch (e) { record('chat model ' + cfg.models.chat, false, e.message); }

  if (chatOnly) return finish();

  // 2. speech
  let audio = null;
  try {
    const r = await fetch(base + '/audio/speech', {
      method: 'POST',
      headers: { ...auth, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: cfg.models.tts, voice: cfg.voice, format: 'mp3', response_format: 'mp3',
        input: 'Hi, this is the PipelineSync discovery call.'
      })
    });
    if (!r.ok) record('speech model ' + cfg.models.tts, false, explain(r.status, await r.text()));
    else {
      audio = Buffer.from(await r.arrayBuffer());
      const kb = audio.length / 1024;
      record('speech model ' + cfg.models.tts + ' (voice ' + cfg.voice + ')', audio.length > 0,
        (kb >= 1 ? Math.round(kb) + ' KB' : audio.length + ' bytes') + ' of audio returned');
    }
  } catch (e) { record('speech model ' + cfg.models.tts, false, e.message); }

  if (noStt || !audio) return finish();

  // 3. transcription (re-uses the clip above, so no extra audio is generated)
  try {
    const form = new FormData();
    form.append('file', new Blob([audio], { type: 'audio/mpeg' }), 'probe.mp3');
    form.append('model', cfg.models.stt);
    form.append('language', cfg.language || 'en');
    const r = await fetch(base + '/audio/transcriptions', { method: 'POST', headers: auth, body: form });
    const text = await r.text();
    if (!r.ok) record('transcription model ' + cfg.models.stt, false, explain(r.status, text));
    else {
      let heard = '';
      try { heard = JSON.parse(text).text || ''; } catch { heard = text.slice(0, 80); }
      record('transcription model ' + cfg.models.stt, true, 'heard "' + heard.trim() + '"');
    }
  } catch (e) { record('transcription model ' + cfg.models.stt, false, e.message); }

  finish();
}

function finish() {
  const failed = results.filter(r => !r.ok);
  console.log('');
  if (!failed.length) {
    console.log('OPENAI PREFLIGHT PASSED - the key works and the voice layer will run on ChatGPT.');
    console.log('Spend for this check: well under USD 0.01. A full discovery call is about USD 0.06.');
    console.log('Next: node server.js, open http://127.0.0.1:8080, agree to the disclaimer - the badge should read "ChatGPT voice".');
    process.exit(0);
  }
  console.log('OPENAI PREFLIGHT FAILED (' + failed.length + ')');
  for (const f of failed) console.log('  - ' + f.name + ': ' + f.detail);
  console.log('');
  console.log('Demos keep working meanwhile: set VOICE_PROVIDER=simulated to run the built-in interviewer with no spend.');
  process.exit(1);
}

main().catch(e => { console.error(e); process.exit(1); });
