'use strict';
/* Optional Anthropic adapter tests. Uses a fake Messages API so no API key or spend is needed. */
const fs = require('fs');
const path = require('path');
const assert = require('assert');
const core = require('../lib/core');
const ai = require('../lib/blueprint-ai');

const personas = JSON.parse(fs.readFileSync(path.join(__dirname, 'personas.json'), 'utf8'));
const answers = Object.entries(personas.solar.answers).map(([id, text]) => ({ id, text }));
const env = {
  BLUEPRINT_AI_PROVIDER: 'anthropic',
  ANTHROPIC_API_KEY: 'sk-test-only',
  ANTHROPIC_MODEL: 'claude-test-model',
  ANTHROPIC_BASE_URL: 'http://mock-anthropic.test/v1',
  ANTHROPIC_STRUCTURED_OUTPUTS: 'on'
};

function fakeFetchFactory() {
  const requests = [];
  const fetchImpl = async (url, init) => {
    requests.push({ url, init, body: JSON.parse(init.body) });
    const body = JSON.parse(init.body);
    const text = body.messages[0].content.includes('Answers:')
      ? JSON.stringify(core.extract(answers))
      : JSON.stringify(core.generate(core.extract(answers)));
    return { ok: true, status: 200, text: async () => JSON.stringify({ content: [{ type: 'text', text }] }) };
  };
  return { requests, fetchImpl };
}

(async () => {
  const fake = fakeFetchFactory();
  const extracted = await ai.extract(answers, { env, fetchImpl: fake.fetchImpl });
  assert.strictEqual(extracted.provider, 'anthropic');
  assert.strictEqual(extracted.fallback, false);
  assert.strictEqual(extracted.fields.typical_deal_size, 1500000);
  assert.strictEqual(fake.requests[0].url, 'http://mock-anthropic.test/v1/messages');
  assert.strictEqual(fake.requests[0].init.headers['x-api-key'], 'sk-test-only');
  assert.strictEqual(fake.requests[0].init.headers['anthropic-version'], '2023-06-01');
  assert.strictEqual(fake.requests[0].body.output_config.format.type, 'json_schema');

  const generated = await ai.generate(extracted.fields, { env, fetchImpl: fake.fetchImpl });
  assert.strictEqual(generated.provider, 'anthropic');
  assert.strictEqual(generated.blueprint.coa.items.length, 3);
  assert.strictEqual(generated.blueprint.pipeline.variant, 'two-call');

  const fallback = await ai.extract(answers, { env, fetchImpl: async () => { throw new Error('offline'); } });
  assert.strictEqual(fallback.provider, 'deterministic');
  assert.strictEqual(fallback.fallback, true);
  assert.strictEqual(fallback.fields.typical_deal_size, 1500000);

  let threw = false;
  try {
    await ai.extract(answers, { env: Object.assign({}, env, { BLUEPRINT_AI_FALLBACK: 'off' }), fetchImpl: async () => { throw new Error('offline'); } });
  } catch (e) { threw = true; }
  assert.strictEqual(threw, true);

  console.log('blueprint-ai: Anthropic adapter and deterministic fallback passed');
})().catch(err => { console.error(err); process.exit(1); });
