import assert from 'node:assert/strict';
import { readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'node:test';
import sharp from 'sharp';
import { createWorker } from '../src/app.js';
import { sha256 } from '../src/security.js';
import { MAX_UPLOAD_BYTES, type Order } from '../src/types.js';
import { createOrder, multipartPayload, readyOrder, signature, smallPng, workerFixture } from './helpers.js';

test('quote persists one PNG and binds finalized chain time; metadata exposes no private files', async t => {
  const fixture = await workerFixture();
  t.after(() => fixture.cleanup());
  const order = await createOrder(fixture);
  assert.match(order.jobId, /^[a-f0-9]{64}$/);
  assert.equal(order.jobAddress, fixture.chain.deriveJob(fixture.buyer.address, order.jobId));
  assert.equal(order.expiresAt, fixture.chain.now + 120);
  assert.equal(order.amount, '5000000');
  assert.equal(order.status, 'quoted');
  assert.equal(order.previewUrl, undefined);
  const stored = await fixture.service.store.read(order.jobId);
  const input = await fixture.service.store.readImage(order.jobId, 'input', stored.input);
  assert.equal((await sharp(input).metadata()).format, 'png');
  await assert.rejects(stat(join(fixture.settings.dataDir, 'orders', order.jobId, 'result.webp')), { code: 'ENOENT' });
  assert.equal(Object.keys(order).some(key => /input|output|path|url|challenge|signature/i.test(key)), false);
  const list = await fixture.app.inject({ method: 'GET', url: `/api/orders?buyer=${fixture.buyer.address}` });
  assert.deepEqual(list.json(), { orders: [order] });
  assert.equal((await fixture.app.inject({ method: 'GET', url: '/health' })).json().ok, true);
  assert.deepEqual((await fixture.app.inject({ method: 'GET', url: '/api/config' })).json(), fixture.chain.config);
});

test('upload rejects invalid PNG, oversize data, unsafe dimensions, bad buyer, and unexpected multipart fields', async t => {
  const fixture = await workerFixture();
  t.after(() => fixture.cleanup());
  const unsafeDimensions = await sharp({ create: { width: 4097, height: 1, channels: 4, background: 'red' } }).png().toBuffer();
  for (const [file, expected] of [[Buffer.from('not a png'), 415], [Buffer.alloc(MAX_UPLOAD_BYTES + 1), 413], [unsafeDimensions, 415]] as const) {
    const response = await fixture.app.inject({ method: 'POST', url: '/api/orders', ...multipartPayload(fixture.buyer.address, 'normal', file) });
    assert.equal(response.statusCode, expected, response.body);
  }
  const badBuyer = await fixture.app.inject({ method: 'POST', url: '/api/orders', ...multipartPayload('../../escape', 'normal', await smallPng()) });
  assert.equal(badBuyer.statusCode, 400);
  const badMode = await fixture.app.inject({ method: 'POST', url: '/api/orders', ...multipartPayload(fixture.buyer.address, 'bypass', await smallPng()) });
  assert.equal(badMode.statusCode, 400);
  const extra = await fixture.app.inject({ method: 'POST', url: '/api/orders', ...multipartPayload(fixture.buyer.address, 'normal', await smallPng(), [['path', '/secret']]) });
  assert.equal(extra.statusCode, 413);
  assert.deepEqual(await fixture.service.store.listIds(), []);
});

test('claimed transaction signature never substitutes for a finalized job and deposit', async t => {
  const fixture = await workerFixture();
  t.after(() => fixture.cleanup());
  const order = await createOrder(fixture);
  const response = await fixture.app.inject({ method: 'POST', url: `/api/orders/${order.jobId}/funded`, payload: { signature: 'fake' } });
  assert.equal(response.statusCode, 409);
  await fixture.service.waitForIdle();
  assert.equal((await fixture.service.store.read(order.jobId)).status, 'quoted');
  await assert.rejects(stat(join(fixture.settings.dataDir, 'orders', order.jobId, 'result.webp')), { code: 'ENOENT' });
});

test('finalized quote and vault mismatches reject processing; a harmless surplus does not block conversion', async t => {
  const fixture = await workerFixture();
  t.after(() => fixture.cleanup());
  const mutations: [string, (order: Order) => void][] = [
    ['buyer', order => { fixture.chain.jobs.get(order.jobAddress)!.buyer = fixture.other.address; }],
    ['merchant', order => { fixture.chain.jobs.get(order.jobAddress)!.merchant = fixture.other.address; }],
    ['mint', order => { fixture.chain.jobs.get(order.jobAddress)!.mint = fixture.other.address; }],
    ['amount', order => { fixture.chain.jobs.get(order.jobAddress)!.amount = '1'; }],
    ['expiry', order => { fixture.chain.jobs.get(order.jobAddress)!.expiresAt += 1; }],
    ['ID', order => { fixture.chain.jobs.get(order.jobAddress)!.jobId = '0'.repeat(64); }],
    ['vault address', order => { fixture.chain.jobs.get(order.jobAddress)!.vault = fixture.other.address; }],
    ['vault amount', order => { fixture.chain.vaults.get(fixture.chain.deriveVault(order.jobAddress))!.amount = '4999999'; }],
    ['vault authority', order => { fixture.chain.vaults.get(fixture.chain.deriveVault(order.jobAddress))!.authority = fixture.other.address; }],
    ['vault mint', order => { fixture.chain.vaults.get(fixture.chain.deriveVault(order.jobAddress))!.mint = fixture.other.address; }],
    ['token program', order => { fixture.chain.vaults.get(fixture.chain.deriveVault(order.jobAddress))!.programOwner = fixture.other.address; }],
    ['vault state', order => { fixture.chain.vaults.get(fixture.chain.deriveVault(order.jobAddress))!.initialized = false; }],
  ];
  for (const [name, mutate] of mutations) {
    const order = await createOrder(fixture);
    fixture.chain.fund(order);
    mutate(order);
    const rejected = await fixture.app.inject({ method: 'POST', url: `/api/orders/${order.jobId}/funded`, payload: {} });
    assert.equal(rejected.statusCode, 409, `${name}: ${rejected.body}`);
    assert.equal((await fixture.service.store.read(order.jobId)).output, undefined, name);
  }
  const surplus = await createOrder(fixture);
  fixture.chain.fund(surplus);
  fixture.chain.vaults.get(fixture.chain.deriveVault(surplus.jobAddress))!.amount = '5000001';
  const accepted = await fixture.app.inject({ method: 'POST', url: `/api/orders/${surplus.jobId}/funded`, payload: {} });
  assert.equal(accepted.statusCode, 200);
  await fixture.service.waitForIdle();
  assert.equal((await fixture.service.read(surplus.jobId)).status, 'ready');
});

test('real PNG produces persisted original WebP before a visibly watermarked preview is advertised', async t => {
  const fixture = await workerFixture();
  t.after(() => fixture.cleanup());
  const ready = await readyOrder(fixture);
  assert.equal(ready.status, 'ready');
  const stored = await fixture.service.store.read(ready.jobId);
  assert.ok(stored.output);
  assert.ok(stored.preview);
  const original = await readFile(join(fixture.settings.dataDir, 'orders', ready.jobId, 'result.webp'));
  assert.equal(sha256(original), stored.output.sha256);
  assert.equal((await sharp(original).metadata()).format, 'webp');
  const previewResponse = await fixture.app.inject({ method: 'GET', url: ready.previewUrl! });
  assert.equal(previewResponse.statusCode, 200);
  const preview = previewResponse.rawPayload;
  const metadata = await sharp(preview).metadata();
  assert.equal(metadata.format, 'webp');
  assert.equal(metadata.width, 360);
  assert.equal(metadata.height, 240);
  assert.notEqual(sha256(original), sha256(preview));
  // A solid cyan source becomes a preview with many colors and a dark caption
  // band. This checks the actual raster, not merely the presence of SVG text.
  const stats = await sharp(preview).stats();
  assert.ok(stats.channels[0]!.stdev > 30);
  const bottom = await sharp(preview).extract({ left: 0, top: 239, width: 1, height: 1 }).removeAlpha().raw().toBuffer();
  assert.ok(bottom[0]! < 60 && bottom[1]! < 70 && bottom[2]! < 80);
  const premature = await fixture.app.inject({ method: 'POST', url: `/api/orders/${ready.jobId}/challenge`, payload: { buyer: fixture.buyer.address } });
  assert.equal(premature.statusCode, 403);
  for (const path of [`/api/orders/${ready.jobId}/result.webp`, `/orders/${ready.jobId}/result.webp`, `/api/orders/${ready.jobId}/input.png`]) {
    assert.equal((await fixture.app.inject({ method: 'GET', url: path })).statusCode, 404);
  }
});

test('private download requires finalized release and original-buyer signature; nonce consumption survives restart', async t => {
  const fixture = await workerFixture();
  t.after(() => fixture.cleanup());
  const order = await readyOrder(fixture);
  fixture.chain.settle(order, 'Released');
  const url = `/api/orders/${order.jobId}`;
  assert.equal((await fixture.app.inject({ method: 'POST', url: `${url}/challenge`, payload: { buyer: fixture.other.address } })).statusCode, 403);
  const challenge = (await fixture.app.inject({ method: 'POST', url: `${url}/challenge`, payload: { buyer: fixture.buyer.address } })).json<{ message: string; nonce: string; expiresAt: number }>();
  assert.ok(challenge.message.includes(order.jobId));
  assert.ok(challenge.message.includes(order.jobAddress));
  const wrongSignature = await fixture.app.inject({ method: 'POST', url: `${url}/download`, payload: { buyer: fixture.buyer.address, nonce: challenge.nonce, signature: signature(fixture.other, challenge.message) } });
  assert.equal(wrongSignature.statusCode, 401);
  const wrongBuyer = await fixture.app.inject({ method: 'POST', url: `${url}/download`, payload: { buyer: fixture.other.address, nonce: challenge.nonce, signature: signature(fixture.other, challenge.message) } });
  assert.equal(wrongBuyer.statusCode, 403);
  const payload = { buyer: fixture.buyer.address, nonce: challenge.nonce, signature: signature(fixture.buyer, challenge.message) };
  const attempts = await Promise.all([fixture.app.inject({ method: 'POST', url: `${url}/download`, payload }), fixture.app.inject({ method: 'POST', url: `${url}/download`, payload })]);
  assert.deepEqual(attempts.map(response => response.statusCode).sort(), [200, 401]);
  const success = attempts.find(response => response.statusCode === 200)!;
  assert.equal(success.headers['cache-control'], 'no-store');
  assert.match(String(success.headers['content-disposition']), /attachment.*\.webp/);
  assert.equal((await sharp(success.rawPayload).metadata()).format, 'webp');
  await fixture.app.close();
  const restarted = await createWorker({ chain: fixture.chain, settings: fixture.settings, logger: false });
  t.after(() => restarted.app.close());
  assert.equal((await restarted.app.inject({ method: 'POST', url: `${url}/download`, payload })).statusCode, 401);
  const fresh = (await restarted.app.inject({ method: 'POST', url: `${url}/challenge`, payload: { buyer: fixture.buyer.address } })).json<{ message: string; nonce: string }>();
  const recovered = await restarted.app.inject({ method: 'POST', url: `${url}/download`, payload: { buyer: fixture.buyer.address, nonce: fresh.nonce, signature: signature(fixture.buyer, fresh.message) } });
  assert.equal(recovered.statusCode, 200);
});

test('public challenge requests preserve a pending buyer signature and never extend its expiry', async t => {
  const fixture = await workerFixture();
  t.after(() => fixture.cleanup());
  const order = await readyOrder(fixture);
  fixture.chain.settle(order, 'Released');
  const url = `/api/orders/${order.jobId}`;
  const issue = async () => {
    const response = await fixture.app.inject({ method: 'POST', url: `${url}/challenge`, payload: { buyer: fixture.buyer.address } });
    assert.equal(response.statusCode, 200);
    return response.json<{ message: string; nonce: string; expiresAt: number }>();
  };
  const original = await issue();
  for (let request = 0; request < 12; request++) assert.deepEqual(await issue(), original);
  const payload = { buyer: fixture.buyer.address, nonce: original.nonce, signature: signature(fixture.buyer, original.message) };
  assert.equal((await fixture.app.inject({ method: 'POST', url: `${url}/download`, payload })).statusCode, 200);
  assert.equal((await fixture.app.inject({ method: 'POST', url: `${url}/download`, payload })).statusCode, 401);
  const fresh = await issue();
  assert.notEqual(fresh.nonce, original.nonce);
  const stored = await fixture.service.store.read(order.jobId);
  stored.challenges[0]!.expiresAt = Math.floor(Date.now() / 1000) - 1;
  await fixture.service.store.save(stored);
  const afterExpiry = await issue();
  assert.notEqual(afterExpiry.nonce, fresh.nonce);
  assert(afterExpiry.expiresAt > Math.floor(Date.now() / 1000));
});

test('expired and cross-order challenges cannot authorize downloads; RPC outage fails closed', async t => {
  const fixture = await workerFixture();
  t.after(() => fixture.cleanup());
  const first = await readyOrder(fixture);
  const second = await readyOrder(fixture);
  fixture.chain.settle(first, 'Released');
  fixture.chain.settle(second, 'Released');
  const firstUrl = `/api/orders/${first.jobId}`;
  const issued = (await fixture.app.inject({ method: 'POST', url: `${firstUrl}/challenge`, payload: { buyer: fixture.buyer.address } })).json<{ message: string; nonce: string }>();
  const payload = { buyer: fixture.buyer.address, nonce: issued.nonce, signature: signature(fixture.buyer, issued.message) };
  const crossOrder = await fixture.app.inject({ method: 'POST', url: `/api/orders/${second.jobId}/download`, payload });
  assert.equal(crossOrder.statusCode, 401);
  const stored = await fixture.service.store.read(first.jobId);
  stored.challenges[0]!.expiresAt = Math.floor(Date.now() / 1000) - 1;
  await fixture.service.store.save(stored);
  assert.equal((await fixture.app.inject({ method: 'POST', url: `${firstUrl}/download`, payload })).statusCode, 401);
  const fresh = (await fixture.app.inject({ method: 'POST', url: `${firstUrl}/challenge`, payload: { buyer: fixture.buyer.address } })).json<{ message: string; nonce: string }>();
  fixture.chain.offline = true;
  const offline = await fixture.app.inject({ method: 'POST', url: `${firstUrl}/download`, payload: { buyer: fixture.buyer.address, nonce: fresh.nonce, signature: signature(fixture.buyer, fresh.message) } });
  assert.equal(offline.statusCode, 503);
});

test('startup discovers finalized funding without notification and resumes durable conversion', async t => {
  const fixture = await workerFixture();
  t.after(() => fixture.cleanup());
  const order = await createOrder(fixture);
  fixture.chain.fund(order);
  await fixture.app.close();
  const restarted = await createWorker({ chain: fixture.chain, settings: fixture.settings, logger: false });
  t.after(() => restarted.app.close());
  await restarted.service.waitForIdle();
  const recovered = (await restarted.app.inject({ method: 'GET', url: `/api/orders/${order.jobId}` })).json<Order>();
  assert.equal(recovered.status, 'ready');
  assert.ok(recovered.previewUrl);
});

test('deterministic stall never converts across restart and reconciles a fixture refund', async t => {
  const fixture = await workerFixture();
  t.after(() => fixture.cleanup());
  const order = await createOrder(fixture, 'stall');
  fixture.chain.fund(order);
  const funded = await fixture.app.inject({ method: 'POST', url: `/api/orders/${order.jobId}/funded`, payload: {} });
  assert.equal(funded.json<Order>().status, 'funded');
  await fixture.service.waitForIdle();
  assert.equal((await fixture.service.store.read(order.jobId)).output, undefined);
  assert.equal((await fixture.app.inject({ method: 'GET', url: `/api/orders/${order.jobId}/preview` })).statusCode, 409);
  await fixture.app.close();
  const restarted = await createWorker({ chain: fixture.chain, settings: fixture.settings, logger: false });
  t.after(() => restarted.app.close());
  await restarted.service.waitForIdle();
  assert.equal((await restarted.service.store.read(order.jobId)).output, undefined);
  // This is a state fixture, not evidence that a real offline refund succeeded.
  fixture.chain.settle(order, 'Refunded');
  assert.equal((await restarted.service.read(order.jobId)).status, 'refunded');
  assert.equal((await restarted.app.inject({ method: 'POST', url: `/api/orders/${order.jobId}/challenge`, payload: { buyer: fixture.buyer.address } })).statusCode, 403);
});

test('CORS permits configured frontend and exposes no permissive credentialed origin', async t => {
  const fixture = await workerFixture();
  t.after(() => fixture.cleanup());
  const allowed = await fixture.app.inject({ method: 'OPTIONS', url: '/api/orders', headers: { origin: 'http://localhost:5173' } });
  assert.equal(allowed.statusCode, 204);
  assert.equal(allowed.headers['access-control-allow-origin'], 'http://localhost:5173');
  assert.equal(allowed.headers['access-control-allow-credentials'], undefined);
  const other = await fixture.app.inject({ method: 'GET', url: '/api/config', headers: { origin: 'https://untrusted.example' } });
  assert.equal(other.headers['access-control-allow-origin'], undefined);
});
