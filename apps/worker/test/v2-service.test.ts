import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'node:test';
import { computeTermsHash } from '@holdfast/chain';
import sharp from 'sharp';
import { ProviderFailure, type AiRequest } from '../src/ai.js';
import { createWorker } from '../src/app.js';
import { jsonBytes, specification, validListing, zipBundle } from '../src/pack.js';
import { sha256 } from '../src/security.js';
import type { OrderV2 } from '../src/v2-types.js';
import { multipartPayload, signature, smallPng } from './helpers.js';
import { BRIEF, CountingAi, login, quote, ready, v2Fixture } from './v2-helpers.js';

test('V2 quote commits original input, fixed specification and exact versioned terms before funding', async t => {
  const f = await v2Fixture(); t.after(() => f.cleanup()); const auth = await login(f, f.buyer);
  const order = await quote(f, auth);
  assert.equal(order.version, 2); assert.equal(order.aiMode, 'fixture'); assert.equal(order.status, 'quoted');
  assert.equal(order.quoteExpiresAt, f.chain.now + 600); assert.equal(order.expiresAt, f.chain.now + 1800);
  assert.equal(order.inputHash, sha256(await smallPng())); assert.equal(order.specHash, sha256(jsonBytes(order.specification)));
  assert.equal(order.termsHash, await computeTermsHash({ programId: f.chain.config.programId, ...order }));
  assert.equal(order.previews, undefined); assert.equal(order.resultHash, undefined);
  assert.equal((f.ai as CountingAi).interpretations, 1); assert.equal((f.ai as CountingAi).edits, 0);
  assert.equal((await f.app.inject({ method: 'POST', url: `/api/v2/orders/${order.jobId}/funded`, headers: auth.headers, payload: { signature: 'pretend-funded' } })).statusCode, 409);
  assert.equal((f.ai as CountingAi).edits, 0);
});

test('multipart V2 accepts a multibyte brief at the character limit and rejects excess characters before AI execution', async t => {
  const f = await v2Fixture(); t.after(() => f.cleanup()); const auth = await login(f, f.buyer);
  const image = await smallPng();
  const submit = async (brief: string) => {
    const multipart = multipartPayload(f.buyer.address, 'normal', image, [['brief', brief]]);
    return f.app.inject({ method: 'POST', url: '/api/v2/orders', ...multipart, headers: { ...multipart.headers, ...auth.headers } });
  };
  const valid = '青'.repeat(2000);
  assert.equal(valid.length, 2000); assert.equal(Buffer.byteLength(valid, 'utf8'), 6000);
  const accepted = await submit(valid);
  assert.equal(accepted.statusCode, 201, accepted.body);
  assert.equal(accepted.json<OrderV2>().specification.brief, valid);
  assert.equal((f.ai as CountingAi).interpretations, 1);
  const rejected = await submit(`${valid}青`);
  assert.equal(rejected.statusCode, 400, rejected.body);
  assert.match(rejected.json<{ error: string }>().error, /20–2000 characters/);
  assert.equal((f.ai as CountingAi).interpretations, 1);
  assert.equal((await f.productService.store.listIds()).length, 1);
});

test('mismatched parties, mint, amount, deadline, vault and every V2 commitment reject finalized funding', async t => {
  const f = await v2Fixture(); t.after(() => f.cleanup()); const auth = await login(f, f.buyer);
  const mutations: [string, string | number][] = [['buyer', f.other.address], ['merchant', f.other.address], ['provider', f.other.address], ['mint', f.other.address],
    ['amount', '1'], ['expiresAt', f.chain.now + 1801], ['quoteExpiresAt', f.chain.now + 601], ['inputHash', 'a'.repeat(64)],
    ['specHash', 'b'.repeat(64)], ['termsHash', 'c'.repeat(64)], ['version', 1], ['vault', f.other.address]];
  for (const [field, value] of mutations) {
    const order = await quote(f, auth); const job = f.chain.fundV2(order);
    (job as unknown as Record<string, unknown>)[field] = value;
    const response = await f.app.inject({ method: 'POST', url: `/api/v2/orders/${order.jobId}/funded`, headers: auth.headers, payload: {} });
    assert.equal(response.statusCode, 409, `${field}: ${response.body}`);
  }
  assert.equal((f.ai as CountingAi).edits, 0);
  const tampered = await quote(f, auth); f.chain.fundV2(tampered);
  const stored = await f.productService.store.read(tampered.jobId); stored.specification.imageDirection = 'Tampered direction'; await f.productService.store.save(stored);
  assert.equal((await f.app.inject({ method: 'GET', url: `/api/v2/orders/${tampered.jobId}`, headers: auth.headers })).statusCode, 409);
});

test('complete pack is durable and byte committed before provider submission; private bundle passes system unzip CRC checks', async t => {
  const f = await v2Fixture(); t.after(() => f.cleanup()); const auth = await login(f, f.buyer); const order = await ready(f, auth);
  assert.equal(order.status, 'ready'); assert.equal(f.chain.submissions, 1); assert.ok(order.validation?.passed);
  assert.equal(order.resultHash, sha256(jsonBytes(order.manifest)));
  assert.deepEqual(order.manifest!.artifacts.map(a => a.path), ['hero.webp', 'listing.json', 'social-portrait.webp', 'social-square.webp', 'social-story.webp', 'validation.json']);
  assert.deepEqual(order.manifest!.previews.map(p => [p.path, p.sourcePath]), [
    ['preview-hero.webp', 'hero.webp'], ['preview-portrait.webp', 'social-portrait.webp'],
    ['preview-square.webp', 'social-square.webp'], ['preview-story.webp', 'social-story.webp'],
  ]);
  const stored = await f.productService.store.read(order.jobId);
  assert.ok(stored.bundle && stored.previewFiles); assert.equal(stored.attempts.length, 3);
  for (const a of stored.manifest!.artifacts) {
    const bytes = await f.productService.store.readFile(order.jobId, a.path, a);
    assert.equal(sha256(bytes), a.sha256);
    if (a.path.endsWith('.webp')) {
      const expected = a.path === 'hero.webp' ? [1600, 1600] : a.path === 'social-portrait.webp' ? [1080, 1350] : a.path === 'social-story.webp' ? [1080, 1920] : [1080, 1080];
      const m = await sharp(bytes).metadata(); assert.deepEqual([m.width, m.height], expected);
    }
  }
  const path = join(f.settings.dataDir, 'orders-v2', order.jobId, 'bundle.zip');
  const unzip = spawnSync('unzip', ['-t', path], { encoding: 'utf8' });
  assert.equal(unzip.status, 0, unzip.stdout + unzip.stderr); assert.match(unzip.stdout, /No errors detected/);
  const entries = spawnSync('unzip', ['-Z', '-1', path], { encoding: 'utf8' });
  assert.equal(entries.status, 0, entries.stderr);
  const paths = entries.stdout.trim().split('\n'); assert.equal(paths.length, 7); assert.equal(paths.some(p => p.startsWith('preview-')), false);
  for (const p of order.previews!) {
    const response = await f.app.inject({ method: 'GET', url: p.url, headers: auth.headers }); assert.equal(response.statusCode, 200);
    const commitment = order.manifest!.previews.find(entry => entry.path === `preview-${p.name}.webp`)!;
    const metadata = await sharp(response.rawPayload).metadata();
    assert.equal(sha256(response.rawPayload), commitment.sha256); assert.equal(response.rawPayload.length, commitment.bytes);
    assert.equal(commitment.mimeType, 'image/webp'); assert.deepEqual([metadata.width, metadata.height], [commitment.width, commitment.height]);
    assert.deepEqual([p.width, p.height], [commitment.width, commitment.height]);
  }
  for (const path of ['hero.webp', 'input.bin', 'bundle.zip', 'manifest.json']) assert.equal((await f.app.inject({ method: 'GET', url: `/api/v2/orders/${order.jobId}/${path}`, headers: auth.headers })).statusCode, 404);
  assert.equal((await f.app.inject({ method: 'POST', url: `/api/v2/orders/${order.jobId}/challenge`, payload: { buyer: f.buyer.address } })).statusCode, 403);
});

test('preview metadata, file bytes and source mapping must agree with the frozen manifest for review and download', async t => {
  const f = await v2Fixture(); t.after(() => f.cleanup()); const auth = await login(f, f.buyer); const order = await ready(f, auth);
  const stored = await f.productService.store.read(order.jobId);
  const committed = stored.manifest!.previews.find(p => p.path === 'preview-hero.webp')!;
  const originalMetadata = { ...stored.previewFiles!.hero! };
  const original = await f.productService.store.readFile(order.jobId, committed.path, { sha256: committed.sha256, size: committed.bytes });
  stored.previewFiles!.hero!.width += 1; await f.productService.store.save(stored);
  await assert.rejects(f.productService.preview(order.jobId, 'hero', f.buyer.address), /Preview metadata differs/);
  stored.previewFiles!.hero = originalMetadata; await f.productService.store.save(stored);
  await f.productService.store.write(order.jobId, committed.path, Buffer.concat([original, Buffer.from('tamper')]));
  await assert.rejects(f.productService.preview(order.jobId, 'hero', f.buyer.address), /integrity/);
  f.chain.settle(order, 'Released');
  assert.equal((await f.app.inject({ method: 'POST', url: `/api/v2/orders/${order.jobId}/challenge`, payload: { buyer: f.buyer.address } })).statusCode, 503);
  await f.productService.store.write(order.jobId, committed.path, original);
  committed.sourcePath = 'social-square.webp';
  // Even an internally consistent provider commitment cannot swap the semantic source mapping.
  stored.resultHash = sha256(jsonBytes(stored.manifest));
  f.chain.jobs.get(order.jobAddress)!.resultHash = stored.resultHash;
  await f.productService.store.save(stored);
  await assert.rejects(f.productService.preview(order.jobId, 'hero', f.buyer.address), /Preview metadata differs/);
  assert.equal((f.ai as CountingAi).edits, 1); assert.equal(f.chain.submissions, 1);
});

test('finalized release and exact manifest gate single-use downloads; cross-wallet, replay and restart do not regenerate outputs', async t => {
  const f = await v2Fixture(); t.after(() => f.cleanup()); const auth = await login(f, f.buyer); const order = await ready(f, auth);
  f.chain.settle(order, 'Released'); const url = `/api/v2/orders/${order.jobId}`;
  assert.equal((await f.app.inject({ method: 'POST', url: `${url}/challenge`, payload: { buyer: f.other.address } })).statusCode, 403);
  const issued = (await f.app.inject({ method: 'POST', url: `${url}/challenge`, payload: { buyer: f.buyer.address } })).json<{ nonce: string; message: string }>();
  assert.ok(issued.message.includes(order.resultHash!)); assert.ok(issued.message.startsWith('osid'));
  assert.equal((await f.app.inject({ method: 'POST', url: `${url}/challenge`, payload: { buyer: f.buyer.address } })).json().nonce, issued.nonce);
  const payload = { buyer: f.buyer.address, nonce: issued.nonce, signature: signature(f.buyer, issued.message) };
  assert.equal((await f.app.inject({ method: 'POST', url: `${url}/download`, payload: { ...payload, signature: signature(f.other, issued.message) } })).statusCode, 401);
  const responses = await Promise.all([f.app.inject({ method: 'POST', url: `${url}/download`, payload }), f.app.inject({ method: 'POST', url: `${url}/download`, payload })]);
  assert.deepEqual(responses.map(r => r.statusCode).sort(), [200, 401]);
  const bytes = responses.find(r => r.statusCode === 200)!.rawPayload;
  assert.equal(sha256(bytes), (await f.productService.store.read(order.jobId)).bundle!.sha256);
  await f.app.close(); const restart = await createWorker({ chain: f.chain, settings: f.settings, ai: f.ai, logger: false }); t.after(() => restart.app.close());
  await restart.productService.waitForIdle();
  assert.equal((await restart.app.inject({ method: 'POST', url: `${url}/download`, payload })).statusCode, 401);
  assert.equal((await restart.app.inject({ method: 'GET', url, headers: auth.headers })).json<OrderV2>().status, 'released');
  assert.equal((f.ai as CountingAi).edits, 1); assert.equal((f.ai as CountingAi).listings, 1); assert.equal(f.chain.submissions, 1);
  const fresh = (await restart.app.inject({ method: 'POST', url: `${url}/challenge`, payload: { buyer: f.buyer.address } })).json<{ nonce: string; message: string }>();
  assert.equal((await restart.app.inject({ method: 'POST', url: `${url}/download`, payload: { buyer: f.buyer.address, nonce: fresh.nonce, signature: signature(f.buyer, fresh.message) } })).rawPayload.equals(bytes), true);
});

test('unknown image completion survives restart without a second chargeable attempt; refund remains visible from Funded', async t => {
  class TimeoutAi extends CountingAi { override async edit(_r: AiRequest): Promise<Buffer> { this.edits++; throw new ProviderFailure(true, 'Fixture image request timed out'); } }
  const ai = new TimeoutAi(); const f = await v2Fixture(ai); t.after(() => f.cleanup()); const auth = await login(f, f.buyer);
  const order = await quote(f, auth); f.chain.fundV2(order);
  await f.app.inject({ method: 'POST', url: `/api/v2/orders/${order.jobId}/funded`, headers: auth.headers, payload: {} }); await f.productService.waitForIdle();
  assert.equal((await f.productService.store.read(order.jobId)).attempts.find(a => a.stage === 'image')!.state, 'uncertain');
  await f.app.close(); const restart = await createWorker({ chain: f.chain, settings: f.settings, ai, logger: false }); t.after(() => restart.app.close());
  for (let i = 0; i < 3; i++) await restart.productService.read(order.jobId, f.buyer.address);
  await restart.productService.waitForIdle(); assert.equal(ai.edits, 1); assert.equal(f.chain.submissions, 0);
  f.chain.settle(order, 'Refunded'); assert.equal((await restart.productService.read(order.jobId, f.buyer.address)).status, 'refunded');
});

test('durable pending stage can reconcile a recorded response ID; completed listing is reused after restart', async t => {
  const f = await v2Fixture(); t.after(() => f.cleanup()); const auth = await login(f, f.buyer); const order = await quote(f, auth);
  f.chain.fundV2(order); const stored = await f.productService.store.read(order.jobId);
  stored.attempts.push({ id: 'a'.repeat(32), stage: 'listing', startedAt: f.chain.now, provider: 'fixture', state: 'pending', providerId: 'resp_fixture' });
  await f.productService.store.save(stored); await f.app.close();
  const restart = await createWorker({ chain: f.chain, settings: f.settings, ai: f.ai, logger: false }); t.after(() => restart.app.close());
  await restart.productService.waitForIdle();
  assert.equal((await restart.productService.read(order.jobId, f.buyer.address)).status, 'ready');
  assert.equal((f.ai as CountingAi).listings, 1); assert.equal((f.ai as CountingAi).edits, 1);
  assert.equal((await restart.productService.store.read(order.jobId)).attempts.find(a => a.stage === 'listing')!.id, 'a'.repeat(32));
});

test('missing or tampered committed artifacts and changed onchain result fail closed without regeneration', async t => {
  const f = await v2Fixture(); t.after(() => f.cleanup()); const auth = await login(f, f.buyer); const order = await ready(f, auth);
  const job = f.chain.jobs.get(order.jobAddress)!; const originalHash = job.resultHash;
  job.resultHash = 'd'.repeat(64);
  assert.equal((await f.app.inject({ method: 'GET', url: `/api/v2/orders/${order.jobId}`, headers: auth.headers })).statusCode, 409);
  job.resultHash = originalHash; f.chain.settle(order, 'Released');
  const path = join(f.settings.dataDir, 'orders-v2', order.jobId, 'hero.webp'); const bytes = await readFile(path);
  await writeFile(path, Buffer.concat([bytes, Buffer.from('tamper')]));
  assert.equal((await f.app.inject({ method: 'POST', url: `/api/v2/orders/${order.jobId}/challenge`, payload: { buyer: f.buyer.address } })).statusCode, 503);
  await rm(path);
  assert.equal((await f.app.inject({ method: 'GET', url: `/api/v2/orders/${order.jobId}`, headers: auth.headers })).statusCode, 503);
  await f.productService.waitForIdle(); assert.equal((f.ai as CountingAi).edits, 1); assert.equal(f.chain.submissions, 1);
});

test('submitted packs can refund; stalled funded jobs never generate and expire at the actual chain deadline', async t => {
  const f = await v2Fixture(); t.after(() => f.cleanup()); const auth = await login(f, f.buyer); const submitted = await ready(f, auth);
  f.chain.now = submitted.expiresAt; f.chain.settle(submitted, 'Refunded'); assert.equal((await f.productService.read(submitted.jobId, f.buyer.address)).status, 'refunded');
  const stalled = await quote(f, auth, 'stall'); f.chain.fundV2(stalled);
  assert.equal((await f.productService.read(stalled.jobId, f.buyer.address, true)).status, 'funded');
  await f.productService.waitForIdle(); assert.equal((f.ai as CountingAi).edits, 1);
});

test('copy guard rejects substring numeric claims and negative instructions; unsafe bundle paths are refused', () => {
  const spec = specification('A 250 g blue ceramic cup. Do not invent prices, certifications or organic claims.', ['A 250 g blue ceramic cup.'], 'Studio');
  const listing = { title: 'Blue cup', description: 'A blue cup weighing 250 g.', bullets: ['Blue', 'Ceramic', 'Curved handle', 'Cup', 'Seller photo'] };
  assert.deepEqual(validListing(listing, spec), listing);
  for (const description of ['A blue cup weighing 25 g.', 'A blue cup weighing 50 g.', 'Organic certified blue cup.', 'A $5 blue cup.']) assert.throws(() => validListing({ ...listing, description }, spec));
  assert.throws(() => zipBundle({ '../secret.json': jsonBytes({}) }));
});
