/* Conversation repair regressions, no network or credentials required. */
const assert = require('node:assert/strict');
const voice = require('../lib/voice');

async function main() {
  for (const text of ['can you repeat that?', 'Repeat the question', 'say that again please']) {
    assert.equal(voice.repairIntent(text), 'repeat');
  }
  for (const text of ['can you clarify?', 'What do you mean?', "I don't understand", 'explain that in simpler words']) {
    assert.equal(voice.repairIntent(text), 'clarify');
  }
  for (const text of ['We have repeat customers', 'Can you clarify? We sell solar panels.', 'Repeat customers spend 500 pesos']) {
    assert.equal(voice.repairIntent(text), null);
  }
  const previous = 'What does your business do?';
  const body = {
    asked: ['business'], current_question_id: 'business', probes: {},
    answers: [{ id: 'business', text: 'can you repeat that?' }],
    transcript: [{ role: 'ai', text: previous }, { role: 'user', text: 'can you repeat that?' }],
    last_answer: 'can you repeat that?', with_audio: false
  };
  const run = (b, extra = {}) => voice.runTurn({ env: {}, body: b, email: 'memory@example.test', voiceCaptures: [], ...extra });
  const repeat = await run(body);
  assert.equal(repeat.say, previous);
  assert.equal(repeat.ask.id, 'business');
  assert.equal(repeat.ask.kind, 'deferred');
  assert.equal(repeat.deferred, true);
  assert.equal(repeat.done, false);
  assert.deepEqual(repeat.captured, []);
  const clarifyBody = { ...body, last_answer: 'can you clarify?', answers: [{ id: 'business', text: 'can you clarify?' }] };
  const fallback = await run(clarifyBody);
  assert.ok(fallback.say.includes(previous));
  assert.equal(fallback.ask.id, 'business');
  assert.equal(fallback.deferred, true);
  const missing = await run({ ...body, transcript: [] });
  assert.match(missing.say, /don't have the earlier wording/);

  let messages;
  const model = await run(clarifyBody, {
    env: { OPENAI_API_KEY: 'test-key' },
    fetchImpl: async (url, init) => {
      messages = JSON.parse(init.body).messages;
      return { ok: true, text: async () => JSON.stringify({ choices: [{ message: { content: JSON.stringify({
        say: 'What do you sell, and who buys it?', deferred: false,
        ask_question_id: 'products', answer_quality: 'complete', captured: []
      }) } }] }) };
    }
  });
  assert.equal(model.deferred, true, 'server keeps repair on pending question even if model tries to advance');
  assert.equal(model.ask.id, 'business');
  const state = JSON.parse(messages[1].content);
  assert.equal(state.conversation_repair, 'clarify');
  assert.equal(state.transcript[0].text, previous);
  assert.match(messages[0].content, /not an unsupported FAQ question/);
  assert.match(voice.realtimeInstructions({}), /do not call record_answer/);
  const resumed = await run({ ...body, last_answer: 'We sell solar panels', answers: [{ id: 'business', text: 'We sell solar panels' }] });
  assert.equal(resumed.ask.id, 'products', 'real answer resumes normal intake');
  console.log('Voice conversation memory regressions passed');
}
main().catch(e => { console.error(e); process.exitCode = 1; });
