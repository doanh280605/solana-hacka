import assert from 'node:assert/strict';
import { test } from 'node:test';
import { OpenAiProvider, type AiRequest } from '../src/ai.js';
import { validateLiveListingGrounding } from '../src/grounding.js';
import { specification } from '../src/pack.js';
import type { Listing } from '../src/v2-types.js';
import { smallPng } from './helpers.js';

const FACTS = ['Morning candle', 'Cedar and amber scent', '250 g amber glass jar', 'black lid', 'cream Morning label'];
function listing(facts: string[] = FACTS): Listing {
  return { title: facts[0]!, description: `${facts.join('. ')}.`, bullets: Array.from({ length: 5 }, (_, index) => facts[index % facts.length]!) };
}

test('live grounding accepts exact agreed phrases and measurement context with minimal neutral connectors', () => {
  const copy = listing();
  assert.deepEqual(validateLiveListingGrounding(copy, FACTS), copy);
  const joined = { ...copy, title: 'Morning candle with Cedar and amber scent',
    description: 'Morning candle with Cedar and amber scent. 250 g amber glass jar. A black lid and cream Morning label.' };
  assert.deepEqual(validateLiveListingGrounding(joined, FACTS), joined);
  const decimalFacts = ['Glass bottle', '1.5 l glass bottle', 'black lid'];
  assert.deepEqual(validateLiveListingGrounding(listing(decimalFacts), decimalFacts), listing(decimalFacts));
  assert.throws(() => validateLiveListingGrounding(copy, []), /explicit agreed product facts/);
});

test('second live-failure regression rejects invented wax weight and photography/style vocabulary', () => {
  const copy = listing();
  for (const description of ['250 g weight of candle wax.',
    'Morning candle on a neutral gray background with soft studio lighting.',
    'Morning candle with a cotton wick.', 'Net weight 250 g.']) {
    assert.throws(() => validateLiveListingGrounding({ ...copy, description }, FACTS), /outside the agreed product facts|measurement fact|attribute association/);
  }
  assert.throws(() => validateLiveListingGrounding({ ...copy, bullets: ['250 g weight of candle wax', ...copy.bullets.slice(1)] }, FACTS), /outside the agreed product facts|measurement fact|attribute association/);
});

test('third live-failure prose remains rejected while exact fact sentences and bullets pass', () => {
  const prose: Listing = { title: 'Morning candle',
    description: 'Morning candle comes in a 250 g amber glass jar. It features a cedar and amber scent. The candle has a black lid and a cream Morning label.',
    bullets: ['Cedar and amber scent', '250 g amber glass jar', 'Black lid', 'Cream Morning label', 'Morning candle'] };
  assert.throws(() => validateLiveListingGrounding(prose, FACTS), /outside the agreed product facts/);
  const exact = { ...prose, description: 'Morning candle. Cedar and amber scent. 250 g amber glass jar. black lid. cream Morning label.' };
  assert.deepEqual(validateLiveListingGrounding(exact, FACTS), exact);
});

test('known numbers and vocabulary cannot be reassigned to another subject or attached to additional components', () => {
  const facts = ['Morning candle', '250 g amber glass jar', '500 g refill pouch', 'candle wax', 'black lid'];
  const copy = listing(facts);
  for (const description of ['250 g candle wax with amber glass jar.', '250 g black lid.', 'Black lid with 250 g amber glass jar.',
    '500 g amber glass jar.', '250 g refill pouch.', '250 g amber glass jar with 500 g refill pouch.']) {
    assert.throws(() => validateLiveListingGrounding({ ...copy, description }, facts), /attribute association|measurement fact/);
  }
  const capacityFacts = ['300 ml capacity', 'curved handle'];
  assert.throws(() => validateLiveListingGrounding({ ...listing(capacityFacts), description: 'Curved handle with 300 ml capacity.' }, capacityFacts), /measurement fact/);
  const separate = { ...copy, description: '250 g amber glass jar. 500 g refill pouch. Black lid.' };
  assert.deepEqual(validateLiveListingGrounding(separate, facts), separate);
});

test('known nonnumeric attributes must remain in their complete approved fact phrases', () => {
  const facts = ['amber glass jar', 'black plastic lid'];
  const copy = listing(facts);
  assert.throws(() => validateLiveListingGrounding({ ...copy, description: 'Black glass jar with amber plastic lid.' }, facts), /attribute association/);
  const exact = { ...copy, description: 'Amber glass jar with a black plastic lid.' };
  assert.deepEqual(validateLiveListingGrounding(exact, facts), exact);
});

test('live adapter rejects unsupported provider copy after one mocked Responses call using facts-only input', async () => {
  let calls = 0;
  const badCopy = { ...listing(), bullets: ['250 g weight of candle wax', ...listing().bullets.slice(1)] };
  const ai = new OpenAiProvider({ dataDir: '/unused', orderLifetimeSeconds: 120, challengeLifetimeSeconds: 60,
    challengeDomain: 'http://localhost:8787', corsOrigins: ['http://localhost:5173'], openaiApiKey: 'server-only-test-key' },
  (async (url: string, init: RequestInit) => {
    calls++; assert.equal(url, 'https://api.openai.com/v1/responses');
    const body = JSON.parse(String(init.body));
    assert.equal(body.model, 'gpt-4.1-mini'); assert.equal(body.temperature, 0);
    assert.equal(body.input[0].content.length, 1);
    assert.deepEqual(JSON.parse(body.input[0].content[0].text), { productFacts: FACTS,
      copyLimits: { titleMax: 80, descriptionMax: 1200, bulletCount: 5, bulletMax: 180 } });
    assert.equal(JSON.stringify(body.input).includes('neutral gray'), false);
    assert.equal(JSON.stringify(body.input).includes('input_image'), false);
    const exampleInput = JSON.parse(body.instructions.match(/^EXAMPLE INPUT: (.+)$/m)[1]);
    const exampleOutput = JSON.parse(body.instructions.match(/^EXAMPLE OUTPUT: (.+)$/m)[1]);
    assert.deepEqual(validateLiveListingGrounding(exampleOutput, exampleInput.productFacts), exampleOutput);
    return Response.json({ id: 'resp_grounding', status: 'completed', output: [{ type: 'message', content: [{ type: 'output_text', text: JSON.stringify(badCopy) }] }] });
  }) as typeof fetch);
  const brief = `${FACTS.join('. ')}. Use a neutral gray background with soft studio lighting.`;
  const request: AiRequest = { attemptId: 'a'.repeat(32), stage: 'listing', brief,
    specification: specification(brief, FACTS, 'Neutral gray studio with soft lighting'), input: await smallPng(),
    inputMediaType: 'image/png', identify: async () => undefined };
  await assert.rejects(ai.listing(request), /outside the agreed product facts|measurement fact|attribute association/);
  assert.equal(calls, 1);
});
