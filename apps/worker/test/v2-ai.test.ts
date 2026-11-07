import assert from 'node:assert/strict';
import { test } from 'node:test';
import sharp from 'sharp';
import { OpenAiProvider, ProviderFailure, type AiRequest, type ProviderIdentity } from '../src/ai.js';
import { specification, validateProductImage } from '../src/pack.js';
import { MAX_UPLOAD_BYTES, type WorkerSettings } from '../src/types.js';
import { smallPng } from './helpers.js';
import { BRIEF, CountingAi, login, quote, v2Fixture } from './v2-helpers.js';

const settings: WorkerSettings = { dataDir: '/unused', orderLifetimeSeconds: 120, challengeLifetimeSeconds: 60,
  challengeDomain: 'http://localhost:8787', corsOrigins: ['http://localhost:5173'], openaiApiKey: 'server-only-test-key', aiTimeoutMs: 1000 };
async function request(stage: AiRequest['stage'] = 'specification'): Promise<AiRequest & { identities: ProviderIdentity[] }> {
  const identities: ProviderIdentity[] = [];
  return { attemptId: 'a'.repeat(32), stage, brief: BRIEF, specification: specification(BRIEF, ['Blue ceramic cup', 'curved handle'], 'Warm studio backdrop'),
    input: await smallPng(), inputMediaType: 'image/png', identities, identify: async id => { identities.push(id); } };
}
function structured(value: unknown, id = 'resp_fixture'): Response {
  return Response.json({ id, status: 'completed', output: [{ type: 'message', content: [{ type: 'output_text', text: JSON.stringify(value) }] }] },
    { headers: { 'x-request-id': 'req_fixture' } });
}
test('runtime Responses requests use strict structured specification/copy schemas and persist provider identifiers', async () => {
  const calls: { url: string; body: Record<string, unknown> }[] = [];
  const fetcher = (async (url: string, init: RequestInit) => {
    assert.equal((init.headers as Record<string, string>).Authorization, 'Bearer server-only-test-key');
    assert.equal((init.headers as Record<string, string>)['X-Client-Request-Id'], 'a'.repeat(32));
    const body = JSON.parse(String(init.body)); calls.push({ url, body });
    if (calls.length === 1) return structured({ productFacts: ['Blue ceramic cup'], imageDirection: 'Preserve the cup and improve studio lighting' });
    return structured({ title: 'Blue ceramic cup', description: 'Blue ceramic cup with a curved handle.', bullets: ['Blue ceramic cup', 'Curved handle', 'Blue ceramic cup', 'Curved handle', 'Blue ceramic cup with a curved handle'] });
  }) as typeof fetch;
  const ai = new OpenAiProvider(settings, fetcher); const specRequest = await request();
  assert.equal((await ai.interpret(specRequest)).productFacts[0], 'Blue ceramic cup');
  const listing = await ai.listing(await request('listing')); assert.equal(listing.bullets.length, 5);
  assert.deepEqual(specRequest.identities, [{ requestId: 'req_fixture' }, { providerId: 'resp_fixture' }]);
  for (const call of calls) {
    assert.equal(call.url, 'https://api.openai.com/v1/responses'); assert.equal(call.body.background, true); assert.equal(call.body.store, true);
    const text = call.body.text as { format: { type: string; strict: boolean; schema: { additionalProperties: boolean } } };
    assert.equal(text.format.type, 'json_schema'); assert.equal(text.format.strict, true); assert.equal(text.format.schema.additionalProperties, false);
  }
  const input = calls[0]!.body.input as { content: { type: string; image_url?: string }[] }[];
  assert.match(input[0]!.content.find(c => c.type === 'input_image')!.image_url!, /^data:image\/png;base64,/);
  const listingInput = calls[1]!.body.input as { content: { type: string; text: string }[] }[];
  assert.equal(calls[0]!.body.temperature, undefined); assert.equal(calls[1]!.body.temperature, 0);
  assert.equal(listingInput[0]!.content.length, 1);
  assert.deepEqual(JSON.parse(listingInput[0]!.content[0]!.text), { productFacts: ['Blue ceramic cup', 'curved handle'],
    copyLimits: { titleMax: 80, descriptionMax: 1200, bulletCount: 5, bulletMax: 180 } });
  assert.equal(listingInput[0]!.content[0]!.text.includes('studio'), false);
  assert.equal(listingInput[0]!.content[0]!.text.includes(BRIEF), false);
});

test('runtime Image Edits sends the original image and explicit identity-preserving prompt, never just a resize', async () => {
  const r = await request('image'); let calls = 0;
  const ai = new OpenAiProvider(settings, (async (url: string, init: RequestInit) => {
    calls++; assert.equal(url, 'https://api.openai.com/v1/images/edits'); const form = init.body as FormData;
    assert.equal(form.get('input_fidelity'), 'high'); assert.equal(form.get('n'), '1'); assert.equal(form.get('model'), 'gpt-image-1.5');
    assert.match(String(form.get('prompt')), /Preserve product identity exactly/);
    assert.equal(Buffer.from(await (form.get('image') as Blob).arrayBuffer()).equals(r.input), true);
    return Response.json({ data: [{ b64_json: r.input.toString('base64') }] }, { headers: { 'x-request-id': 'req_image' } });
  }) as typeof fetch);
  assert.equal((await ai.edit(r)).equals(r.input), true); assert.equal(calls, 1);
  assert.deepEqual(r.identities, [{ requestId: 'req_image' }]);
});

test('recorded Responses IDs resume with GET and never issue a new POST', async () => {
  const r = await request(); r.existingProviderId = 'resp_previous'; let calls = 0;
  const ai = new OpenAiProvider(settings, (async (url: string, init: RequestInit) => {
    calls++; assert.equal(url, 'https://api.openai.com/v1/responses/resp_previous'); assert.equal(init.method, 'GET');
    return structured({ productFacts: ['Blue ceramic cup'], imageDirection: 'Neutral background' }, 'resp_previous');
  }) as typeof fetch);
  assert.equal((await ai.interpret(r)).productFacts[0], 'Blue ceramic cup'); assert.equal(calls, 1);
});

test('provider timeouts and server errors retain unknown completion and never blindly repeat chargeable POSTs', async () => {
  let calls = 0;
  const ai = new OpenAiProvider({ ...settings, aiTimeoutMs: 20 }, (async (_url: string, init: RequestInit) => {
    calls++; return new Promise<Response>((_resolve, reject) => init.signal!.addEventListener('abort', () => reject(new Error('timeout')), { once: true }));
  }) as typeof fetch);
  // Keep one ordinary timer alive because AbortSignal.timeout is unref'ed in Node.
  const keepAlive = setTimeout(() => undefined, 100);
  try { await assert.rejects(ai.edit(await request('image')), (e: unknown) => e instanceof ProviderFailure && e.uncertain); }
  finally { clearTimeout(keepAlive); }
  assert.equal(calls, 1);
  const failed = new OpenAiProvider(settings, (async () => { calls++; return Response.json({ error: 'fixture secret is never exposed' }, { status: 500 }); }) as typeof fetch);
  await assert.rejects(failed.interpret(await request()), (e: unknown) => e instanceof ProviderFailure && e.uncertain && !e.message.includes('fixture secret'));
  assert.equal(calls, 2);
});

test('missing credentials, unsupported facts, refusals and invalid images fail without inventing usable outputs', async t => {
  const unavailable = new OpenAiProvider({ ...settings, openaiApiKey: undefined }); assert.equal(unavailable.available(), false);
  await assert.rejects(unavailable.interpret(await request()), /Live AI is not configured/);
  const wrongFacts = new OpenAiProvider(settings, (async () => structured({ productFacts: ['Certified waterproof titanium'], imageDirection: 'Studio' })) as typeof fetch);
  await assert.rejects(wrongFacts.interpret(await request()), /unsupported facts/);
  const refusal = new OpenAiProvider(settings, (async () => Response.json({ id: 'resp_refusal', status: 'completed', output: [{ type: 'message', content: [{ type: 'refusal', refusal: 'No' }] }] })) as typeof fetch);
  await assert.rejects(refusal.interpret(await request()), /no structured output/);
  class InvalidImage extends CountingAi { override async edit(_r: AiRequest): Promise<Buffer> { this.edits++; return Buffer.from('invalid image'); } }
  const f = await v2Fixture(new InvalidImage()); t.after(() => f.cleanup()); const auth = await login(f, f.buyer); const order = await quote(f, auth); f.chain.fundV2(order);
  await f.productService.read(order.jobId, f.buyer.address, true); await f.productService.waitForIdle();
  const failed = await f.productService.store.read(order.jobId); assert.equal(failed.status, 'failed'); assert.equal(failed.manifest, undefined);
  assert.equal(failed.attempts.find(a => a.stage === 'image')!.state, 'failed'); assert.equal(f.chain.submissions, 0);
});

test('source image validation accepts PNG/JPEG/WebP and rejects corrupt, oversized or excessive dimensions', async () => {
  const png = await smallPng(); const jpeg = await sharp(png).jpeg().toBuffer(); const webp = await sharp(png).webp().toBuffer();
  for (const [bytes, type] of [[png, 'image/png'], [jpeg, 'image/jpeg'], [webp, 'image/webp']] as const) assert.equal((await validateProductImage(bytes)).mediaType, type);
  await assert.rejects(validateProductImage(png.subarray(0, 50)));
  await assert.rejects(validateProductImage(Buffer.alloc(MAX_UPLOAD_BYTES + 1)), /at most 5 MiB/);
  await assert.rejects(validateProductImage(await sharp({ create: { width: 4097, height: 1, channels: 3, background: 'white' } }).png().toBuffer()));
});
