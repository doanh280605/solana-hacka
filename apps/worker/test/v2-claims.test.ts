import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { AiRequest } from '../src/ai.js';
import { jsonBytes, specification, validListing, zipBundle } from '../src/pack.js';
import { sha256 } from '../src/security.js';
import type { Listing } from '../src/v2-types.js';
import { smallPng } from './helpers.js';
import { CountingAi, login, ready, v2Fixture } from './v2-helpers.js';

const BRIEF = 'Morning candle. Cedar and amber scent. 250 g amber glass jar. Black lid. Cream Morning label. Use a clean warm studio background.';
const NEUTRAL: Listing = {
  title: 'Morning Cedar & Amber Candle',
  description: 'Cedar and amber scent in a 250 g amber glass jar with a black lid and cream Morning label.',
  bullets: ['Cedar and amber scent', '250 g amber glass jar', 'Black lid', 'Cream Morning label', 'Morning candle'],
};
const UNSUPPORTED: Listing = {
  ...NEUTRAL,
  description: 'Morning candle with Cedar and amber scent in a sturdy 250 g amber glass jar. Its black lid ensures the candle remains fresh.',
  bullets: [...NEUTRAL.bullets.slice(0, 2), 'Black lid to keep the candle fresh when not in use.', ...NEUTRAL.bullets.slice(3)],
};

test('live-failure regression rejects inferred sturdiness and lid freshness benefits while neutral supplied facts pass', () => {
  const spec = specification(BRIEF, ['250 g amber glass jar', 'Black lid'], 'Clean warm studio');
  assert.deepEqual(validListing(NEUTRAL, spec), NEUTRAL);
  assert.throws(() => validListing(UNSUPPORTED, spec), /unsupported functional, freshness, durability, health or quality claim/);
  for (const description of ['A sturdy 250 g amber glass jar.', 'Its black lid ensures the candle remains fresh.',
    'The black lid helps preserve the scent.', 'Calming Cedar and amber scent.', 'Premium amber glass jar.']) {
    assert.throws(() => validListing({ ...NEUTRAL, description }, spec), /unsupported/);
  }
  assert.throws(() => validListing({ ...NEUTRAL, bullets: UNSUPPORTED.bullets }, spec), /unsupported/);
  const unrelatedFreshness = specification(`${BRIEF} Fresh cedar scent.`, ['Fresh cedar scent'], 'Studio');
  assert.throws(() => validListing({ ...NEUTRAL, description: 'The black lid keeps the candle fresh.' }, unrelatedFreshness), /unsupported/);
  for (const [brief, description] of [['Blue ceramic mug with a curved handle.', 'The mug keeps drinks hot.'],
    ['Cotton tote with a green print.', 'Heavy-duty cotton tote.']]) {
    const listing = { title: 'Product listing', description: description!,
      bullets: ['Seller supplied details', 'Product photograph', 'Supplied color', 'Supplied components', 'Review required'] };
    assert.throws(() => validListing(listing, specification(brief!, [], 'Studio')), /unsupported functional/);
  }
});

test('explicit positive seller benefit wording passes; negation and stronger or reassigned claims do not', () => {
  const claims = ['Sturdy 250 g amber glass jar.', 'The black lid keeps the candle fresh when not in use.',
    'The black lid helps preserve the scent.', 'Durable amber glass jar.'];
  for (const claim of claims) {
    const spec = specification(`${BRIEF} ${claim}`, [claim], 'Studio');
    const listing = { ...NEUTRAL, description: claim };
    assert.deepEqual(validListing(listing, spec), listing);
  }
  const negated = specification(`${BRIEF} The jar is not sturdy. The lid does not keep the candle fresh. Do not invent freshness or durability claims.`, [], 'Studio');
  assert.throws(() => validListing(UNSUPPORTED, negated), /unsupported/);
  const supported = specification(`${BRIEF} Sturdy 250 g amber glass jar.`, [], 'Studio');
  assert.throws(() => validListing({ ...NEUTRAL, description: 'Shatterproof sturdy 250 g amber glass jar.' }, supported), /unsupported/);
});

test('negative prefixes, neither/nor and lack cannot support positive benefits or dropped qualifiers', () => {
  const cases = [
    ['Non-airtight seal.', 'Airtight seal.'],
    ['The lid is neither airtight nor protective.', 'Airtight.'],
    ['The lid is neither airtight nor protective.', 'Protective.'],
    ['The package lacks protective cushioning.', 'Protective cushioning.'],
    ['The package has a lack of protective cushioning.', 'Protective cushioning.'],
    ['The package is lacking protective cushioning.', 'Protective cushioning.'],
    ['Un-safe seal.', 'Safe seal.'],
    ['Unreliable seal.', 'Reliable seal.'],
    ['Non-durable glass jar.', 'Durable glass jar.'],
    ['The lid does not keep contents fresh.', 'Keep contents fresh.'],
    ["The lid doesn't keep contents fresh.", 'Keep contents fresh.'],
    ['The lid isn’t protective.', 'Protective.'],
    ['The lid may keep contents fresh.', 'Keep contents fresh.'],
    ['The lid keeps contents fresh only when chilled.', 'The lid keeps contents fresh.'],
  ];
  for (const [brief, description] of cases) {
    const spec = specification(`${BRIEF} ${brief}`, [], 'Studio');
    assert.throws(() => validListing({ ...NEUTRAL, description: description! }, spec), /unsupported functional/, `${brief} -> ${description}`);
  }
  for (const claim of ['Airtight seal.', 'Protective cushioning.', 'Reliable seal.', 'Safe seal.',
    'The lid may keep contents fresh.', 'The lid keeps contents fresh only when chilled.',
    'The black lid keeps the candle fresh when not in use.']) {
    const listing = { ...NEUTRAL, description: claim };
    assert.deepEqual(validListing(listing, specification(`${BRIEF} ${claim}`, [claim], 'Studio')), listing);
  }
});

test('delivery verifies frozen historical artifact bytes without applying later listing semantic rules', async t => {
  const f = await v2Fixture(); t.after(() => f.cleanup()); const auth = await login(f, f.buyer);
  const order = await ready(f, auth); const stored = await f.productService.store.read(order.jobId);
  // Isolated chain/storage fixture representing an earlier accepted result, never a real order migration.
  const historicalListing = { ...stored.listing!, description: 'The cup is sturdy.' };
  assert.throws(() => validListing(historicalListing, stored.specification), /unsupported/);
  const files: Record<string, Buffer> = {};
  for (const artifact of stored.manifest!.artifacts) files[artifact.path] = await f.productService.store.readFile(order.jobId, artifact.path, artifact);
  const listingBytes = jsonBytes(historicalListing); files['listing.json'] = listingBytes;
  const listingArtifact = stored.manifest!.artifacts.find(artifact => artifact.path === 'listing.json')!;
  listingArtifact.sha256 = sha256(listingBytes); listingArtifact.size = listingBytes.length;
  const manifestBytes = jsonBytes(stored.manifest); stored.resultHash = sha256(manifestBytes);
  stored.listing = historicalListing; files['manifest.json'] = manifestBytes;
  const bundle = zipBundle(files); stored.bundle = { sha256: sha256(bundle), size: bundle.length };
  await f.productService.store.write(order.jobId, 'listing.json', listingBytes);
  await f.productService.store.write(order.jobId, 'manifest.json', manifestBytes);
  await f.productService.store.write(order.jobId, 'bundle.zip', bundle);
  await f.productService.store.save(stored);
  const job = f.chain.jobs.get(order.jobAddress)!; job.resultHash = stored.resultHash;
  f.chain.settle(order, 'Released');
  const recovered = await f.productService.read(order.jobId, f.buyer.address);
  assert.equal(recovered.status, 'released'); assert.deepEqual(recovered.listing, historicalListing);
  assert.ok((await f.productService.challenge(order.jobId, f.buyer.address)).message.includes(stored.resultHash));
  assert.equal((f.ai as CountingAi).edits, 1); assert.equal(f.chain.submissions, 1);
});

test('unsupported provider copy fails its persisted stage before image generation or result submission', async t => {
  class UnsupportedCopyAi extends CountingAi {
    override async listing(_request: AiRequest): Promise<Listing> { this.listings++; return UNSUPPORTED; }
  }
  const ai = new UnsupportedCopyAi(); const f = await v2Fixture(ai); t.after(() => f.cleanup());
  const order = await f.productService.create(f.buyer.address, f.buyer.address, 'normal', BRIEF, await smallPng());
  f.chain.fundV2(order);
  await f.productService.read(order.jobId, f.buyer.address, true);
  await f.productService.waitForIdle();
  const stored = await f.productService.store.read(order.jobId);
  assert.equal(stored.status, 'failed'); assert.match(stored.error!, /unsupported/);
  assert.equal(stored.attempts.find(attempt => attempt.stage === 'listing')!.state, 'failed');
  assert.equal(stored.resultHash, undefined); assert.equal(stored.manifest, undefined);
  assert.equal(ai.listings, 1); assert.equal(ai.edits, 0); assert.equal(f.chain.submissions, 0);
  await f.productService.read(order.jobId, f.buyer.address);
  await f.productService.waitForIdle();
  assert.equal(ai.listings, 1); assert.equal(ai.edits, 0);
});
