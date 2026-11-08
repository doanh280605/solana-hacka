import assert from 'node:assert/strict';
import { test } from 'node:test';
import sharp from 'sharp';
import type { AiRequest } from '../src/ai.js';
import { sha256 } from '../src/security.js';
import type { Listing } from '../src/v2-types.js';
import { CountingAi, login, ORIGIN, quote, ready, v2Fixture } from './v2-helpers.js';

test('independent review: a funded job waiting for AI capacity runs without browser polling or restart', { timeout: 20000 }, async t => {
  let releaseFirst!: () => void;
  let firstStarted!: () => void;
  const barrier = new Promise<void>(resolve => { releaseFirst = resolve; });
  const started = new Promise<void>(resolve => { firstStarted = resolve; });
  class GatedAi extends CountingAi {
    override async listing(request: AiRequest): Promise<Listing> {
      const first = this.listings === 0;
      const result = await super.listing(request);
      if (first) { firstStarted(); await barrier; }
      return result;
    }
  }
  const ai = new GatedAi();
  const f = await v2Fixture(ai);
  f.settings.maxConcurrentGenerations = 1;
  t.after(async () => { releaseFirst(); await f.cleanup(); });
  const auth = await login(f, f.buyer);
  const first = await quote(f, auth), waiting = await quote(f, auth);
  f.chain.fundV2(first); f.chain.fundV2(waiting);
  await f.productService.read(first.jobId, f.buyer.address, true);
  await started;
  await f.productService.read(waiting.jobId, f.buyer.address, true);
  // Let the scheduler observe saturated capacity before freeing the first request.
  await new Promise<void>(resolve => setImmediate(resolve));
  releaseFirst();
  await f.productService.waitForIdle();
  // No GET/read/restart for `waiting` is allowed here: acknowledged work must drain itself.
  assert.equal(f.chain.jobs.get(waiting.jobAddress)?.state, 'Submitted');
  const stored = await f.productService.store.read(waiting.jobId);
  assert.equal(stored.status, 'ready');
  assert.equal(ai.listings, 2);
  assert.equal(ai.edits, 2);
  assert.equal(f.chain.submissions, 2);
});

test('independent review: finishing an unfunded quote also wakes a funded job waiting for shared AI capacity', { timeout: 20000 }, async t => {
  let releaseQuote!: () => void;
  let quoteStarted!: () => void;
  const barrier = new Promise<void>(resolve => { releaseQuote = resolve; });
  const started = new Promise<void>(resolve => { quoteStarted = resolve; });
  class GatedQuoteAi extends CountingAi {
    override async interpret(request: AiRequest): Promise<{ productFacts: string[]; imageDirection: string }> {
      const block = this.interpretations === 1;
      const result = await super.interpret(request);
      if (block) { quoteStarted(); await barrier; }
      return result;
    }
  }
  const ai = new GatedQuoteAi();
  const f = await v2Fixture(ai);
  f.settings.maxConcurrentGenerations = 1;
  t.after(async () => { releaseQuote(); await f.cleanup(); });
  const auth = await login(f, f.buyer);
  const paid = await quote(f, auth);
  const unrelatedQuote = quote(f, auth);
  await started;
  f.chain.fundV2(paid);
  await f.productService.read(paid.jobId, f.buyer.address, true);
  await new Promise<void>(resolve => setImmediate(resolve));
  releaseQuote();
  await unrelatedQuote;
  await f.productService.waitForIdle();
  assert.equal(f.chain.jobs.get(paid.jobAddress)?.state, 'Submitted');
  assert.equal(ai.edits, 1);
  assert.equal(f.chain.submissions, 1);
});

test('independent review: preview bytes cannot change under an unchanged submitted result even if mutable preview metadata changes', async t => {
  const f = await v2Fixture(); t.after(() => f.cleanup());
  const auth = await login(f, f.buyer), order = await ready(f, auth);
  const stored = await f.productService.store.read(order.jobId);
  const replacement = await sharp({ create: { width: 560, height: 560, channels: 3, background: '#ff0000' } }).webp().toBuffer();
  await f.productService.store.write(order.jobId, 'preview-hero.webp', replacement);
  stored.previewFiles!.hero = { sha256: sha256(replacement), size: replacement.length, width: 560, height: 560 };
  await f.productService.store.save(stored);
  assert.equal(f.chain.jobs.get(order.jobAddress)!.resultHash, order.resultHash);
  await assert.rejects(f.productService.preview(order.jobId, 'hero', f.buyer.address), /preview|manifest|commitment|integrity/i);
});

test('independent review: credentialed config reads permit the trusted origin with query parameters and reject origin lookalikes', async t => {
  const f = await v2Fixture(); t.after(() => f.cleanup());
  const auth = await login(f, f.buyer);
  const allowed = await f.app.inject({ method: 'GET', url: '/api/config?fresh=1', headers: auth.headers });
  assert.equal(allowed.statusCode, 200);
  assert.equal(allowed.headers['access-control-allow-origin'], ORIGIN);
  assert.equal(allowed.headers['access-control-allow-credentials'], 'true');
  assert.equal(allowed.headers['cache-control'], 'no-store');
  assert.deepEqual(allowed.json(), f.chain.config);
  for (const origin of ['null', 'http://localhost:5174', 'https://localhost:5173', 'http://localhost.evil.example:5173']) {
    const rejected = await f.app.inject({ method: 'GET', url: '/api/config?fresh=1', headers: { ...auth.headers, origin } });
    assert.equal(rejected.headers['access-control-allow-origin'], undefined, origin);
    assert.equal(rejected.headers['access-control-allow-credentials'], undefined, origin);
  }
});
