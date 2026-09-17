'use strict';
/* A stand-in OpenAI endpoint for local testing without a key. Point the voice layer at it and the
 * whole ChatGPT voice path (turn wording, speech out, transcription in) is exercised for real over
 * HTTP, with no OpenAI account and no spend:
 *
 *   node test/mock-openai.js 8099
 *   OPENAI_API_KEY=sk-mock OPENAI_BASE_URL=http://127.0.0.1:8099/v1 PORT=8081 node server.js
 *
 * It records every request it receives, so tests can assert exactly what was sent
 * (GET /__requests, GET /__reset). It is also required in-process by test/voice-openai.js.
 */
const http = require('http');

const TRANSCRIPTS = [
  'We install residential and commercial solar systems for homeowners and small businesses in Ilocos.',
  'Residential install at 1,200,000 pesos, and commercial at 4,500,000 pesos, and commercial needs a site survey first.',
  'About 1,500,000 a deal, and three reps take calls.',
  'Six people, and our own crew does the installs.',
  'It is me, with one operations assistant.',
  'Two calls. First we qualify and do the survey, then we present the proposal.',
  'Google Ads about 25 a month tracked, Facebook about 18 a month tracked, and walk-ins about 10 a month not tracked.',
  'They land in a spreadsheet, and I use HubSpot Starter plus WhatsApp and Excel.',
  '55 leads a month, I close 12, so about 22 percent, and three weeks from first call to signed.',
  '80,000 on ads, about 15,000 on software.',
  'Follow-ups slip and I have no visibility on who is where in the process.',
  '20 closed installs a month.'
];
function createMock(port) {
  const requests = [];
  const log = [];
  let transcriptsServed = 0;

  function json(res, code, obj) {
    res.writeHead(code, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(obj));
  }
  function readBody(req) {
    return new Promise(resolve => {
      const d = [];
      req.on('data', c => d.push(c));
      req.on('end', () => resolve(Buffer.concat(d)));
    });
  }
  /* The mock interviewer repeats the assigned question from the state block, so the scripted
     guardrail set still drives the call while ChatGPT does the wording in production. */
  function wordingFor(bodyText) {
    let state = {};
    try {
      const parsed = JSON.parse(bodyText);
      const user = parsed.messages[parsed.messages.length - 1];
      state = JSON.parse(user.content);
    } catch (e) {}
    const turn = state.this_turn || {};
    const q = turn.if_the_answer_is_thin_ask_this_instead || turn.the_question_to_ask;
    const last = state.last_answer ? String(state.last_answer).slice(0, 60) : '';
    const say = q
      ? (last ? 'Right, thank you. ' : 'Hello, this is Alex from PipelineSync. ') + q
      : 'That is everything I need. Review what we captured and I will build the blueprint.';
    const captured = [];
    const m = String(state.last_answer || '').match(/(\d[\d,]*)\s+leads a month/i);
    if (m) captured.push({ field: 'monthly_lead_volume', value: m[1].replace(/,/g, ''), evidence: m[0] });
    return { say, ask_question_id: turn.assigned_question_id || null, captured };
  }

  const server = http.createServer(async (req, res) => {
    const buf = await readBody(req);
    const url = (req.url || '').split('?')[0];

    if (req.method === 'GET' && url === '/__requests') return json(res, 200, requests);
    if (req.method === 'GET' && url === '/__reset') { requests.length = 0; return json(res, 200, { ok: true }); }

    if (url === '/v1/chat/completions') {
      const bodyText = buf.toString('utf8');
      let body = null;
      try { body = JSON.parse(bodyText); } catch (e) {}
      requests.push({ kind: 'chat', auth: req.headers.authorization, body: body });
      if ((req.headers.authorization || '') === 'Bearer sk-bad') {
        return json(res, 401, { error: { message: 'Incorrect API key provided' } });
      }
      return json(res, 200, {
        choices: [{ message: { role: 'assistant', content: JSON.stringify(wordingFor(bodyText)) } }],
        usage: { prompt_tokens: 120, completion_tokens: 30, total_tokens: 150 }
      });
    }
    if (url === '/v1/audio/speech') {
      let body = null;
      try { body = JSON.parse(buf.toString('utf8')); } catch (e) {}
      requests.push({ kind: 'speech', auth: req.headers.authorization, body: body });
      const fake = Buffer.from([0xFF, 0xFB, 0x90, 0x64, 0x00, 0x00, 0x00, 0x00]); // token MP3 bytes
      res.writeHead(200, { 'Content-Type': 'audio/mpeg', 'Content-Length': fake.length });
      return res.end(fake);
    }
    if (url === '/v1/audio/transcriptions') {
      const raw = buf.toString('latin1');
      requests.push({ kind: 'transcription', contentType: req.headers['content-type'], size: buf.length, hasFile: /name="file"/.test(raw) });
      const text = TRANSCRIPTS[Math.min(transcriptsServed, TRANSCRIPTS.length - 1)];
      transcriptsServed++;
      return json(res, 200, { text: text });
    }
    return json(res, 404, { error: { message: 'No such mock route: ' + url } });
  });

  server.on('listening', () => log.push('mock OpenAI listening on http://127.0.0.1:' + port + '/v1'));
  return {
    server,
    requests,
    start() { return new Promise(resolve => server.listen(port, '127.0.0.1', resolve)); },
    reset() { requests.length = 0; transcriptsServed = 0; },
    stop() { return new Promise(resolve => server.close(resolve)); },
    log
  };
}

if (require.main === module) {
  const mock = createMock(parseInt(process.argv[2] || '8099', 10));
  mock.start().then(() => mock.log.forEach(l => console.log(l)));
}

module.exports = { createMock };
