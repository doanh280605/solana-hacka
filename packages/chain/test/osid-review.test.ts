import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { test } from 'node:test';
import sharp from 'sharp';
import { Keypair } from '@solana/web3.js';
import { computeTermsHash, deriveJobV2Address, hashCanonical, type Job, type PublicConfig } from '../src/index.js';
import { assertOrder, assertResult } from '../../../apps/web/src/commitments.js';
import { verifyBundle } from '../../../apps/web/src/bundle.js';
import { verifyPreviewBytes } from '../../../apps/web/src/previews.js';
import type { Order, Specification } from '../../../apps/web/src/types.js';
import { jsonBytes, zipBundle } from '../../../apps/worker/src/pack.js';

const address = () => Keypair.generate().publicKey.toBase58();
const sha256 = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
const buffer = (data: Uint8Array) => Uint8Array.from(data).buffer;
async function submittedFixture(): Promise<{ order: Order; job: Job; config: PublicConfig; files: Record<string, Buffer>; previewFiles: Record<string, Buffer> }> {
  const config: PublicConfig = { programId: '7cW6fScgHCAWBo9YDQEhuS6brFjssJSmomRN11Xa9iKY',
    rpcUrl: 'http://127.0.0.1:8899', cluster: 'localnet', mint: address(), merchant: address(),
    provider: address(), decimals: 6, amount: '5000000' };
  const buyer = address(), jobId = '51'.repeat(32);
  const jobAddress = deriveJobV2Address(config, buyer, jobId).toBase58();
  const specification: Specification = { schemaVersion: 2, service: 'product-listing-pack',
    brief: 'Blue ceramic cup with a curved handle. Preserve the product identity.',
    productFacts: ['Blue ceramic cup'], imageDirection: 'Warm studio background',
    deliverables: { hero: { width: 1600, height: 1600, format: 'webp' },
      social: [{ name: 'square', width: 1080, height: 1080, format: 'webp' },
        { name: 'portrait', width: 1080, height: 1350, format: 'webp' },
        { name: 'story', width: 1080, height: 1920, format: 'webp' }],
      copy: { titleMax: 80, descriptionMax: 1200, bulletCount: 5, bulletMax: 180 } },
    acceptanceChecks: ['Exact dimensions, fields, count, file hashes and bundle completeness'],
    limitations: ['Buyer review is required; hashes do not prove subjective quality.'] };
  const listing = { title: 'Blue ceramic cup', description: 'A blue ceramic cup with a curved handle.',
    bullets: ['Blue ceramic cup', 'Curved handle', 'Seller supplied facts', 'Product photograph', 'Review before approval'] };
  const validation = { schemaVersion: 2 as const, passed: true,
    checks: [{ name: 'Complete pack', passed: true, detail: 'Four images and the agreed copy are present.' }],
    limitations: ['Buyer review remains necessary.'] };
  const terms = { programId: config.programId, jobAddress, jobId, buyer, merchant: config.merchant,
    provider: config.provider!, mint: config.mint, amount: config.amount, expiresAt: 1800,
    quoteExpiresAt: 600, inputHash: '12'.repeat(32), specHash: await hashCanonical(specification) };
  const termsHash = await computeTermsHash(terms);
  const paths = ['hero.webp', 'listing.json', 'social-portrait.webp', 'social-square.webp', 'social-story.webp', 'validation.json'];
  const files = Object.fromEntries(paths.map(path => [path,
    jsonBytes(path === 'listing.json' ? listing : path === 'validation.json' ? validation : { image: path })]));
  const sources = { hero: 'hero.webp', portrait: 'social-portrait.webp', square: 'social-square.webp', story: 'social-story.webp' };
  const previewFiles = Object.fromEntries(await Promise.all(Object.keys(sources).map(async name => [name,
    await sharp({ create: { width: 64, height: 64, channels: 3, background: '#f0e8da' } }).webp().toBuffer()])));
  const manifest = { schemaVersion: 2 as const, jobId, jobAddress, termsHash,
    specHash: terms.specHash, inputHash: terms.inputHash, artifacts: await Promise.all(paths.map(async path => {
      const data = path === 'listing.json' ? listing : path === 'validation.json' ? validation : { image: path };
      return { path, mediaType: path.endsWith('.json') ? 'application/json' : 'image/webp',
        sha256: await hashCanonical(data), size: files[path]!.byteLength };
    })), previews: Object.entries(sources).map(([name, sourcePath]) => ({ path: `preview-${name}.webp`, sourcePath,
      sha256: sha256(previewFiles[name]!), bytes: previewFiles[name]!.length, width: 64, height: 64, mimeType: 'image/webp' as const })) };
  const resultHash = await hashCanonical(manifest);
  const order: Order = { ...terms, version: 2, termsHash, specification, listing, validation, manifest,
    resultHash, aiMode: 'fixture', mode: 'normal', status: 'ready',
    previews: ['hero', 'square', 'portrait', 'story'].map(name => ({ name,
      url: `/api/v2/orders/${jobId}/preview/${name}`, width: 64, height: 64 })) };
  const job: Job = { ...terms, version: 2, address: jobAddress, state: 'Submitted',
    vault: address(), termsHash, resultHash, submittedAt: 500 };
  files['manifest.json'] = jsonBytes(manifest);
  return { order, job, config, files, previewFiles };
}

test('independent review: approval binds the displayed copy and validation bytes to the submitted manifest', async () => {
  const { order, job } = await submittedFixture();
  await assertResult(order, job);
  const changedCopy = structuredClone(order);
  changedCopy.listing!.description = 'Different attractive copy not committed in listing.json.';
  await assert.rejects(assertResult(changedCopy, job), /listing|copy|commit|artifact/i);
  const changedValidation = structuredClone(order);
  changedValidation.validation!.checks[0]!.detail = 'A different validation report that the provider did not commit.';
  await assert.rejects(assertResult(changedValidation, job), /validation|commit|artifact/i);
});

test('independent review: valid-looking changed specification cannot retain the accepted terms commitment', async () => {
  const { order, job, config } = await submittedFixture();
  await assertOrder(order, config, order.buyer, job);
  const changed = structuredClone(order);
  changed.specification.imageDirection = 'A different product scene after acceptance';
  changed.specHash = await hashCanonical(changed.specification);
  await assert.rejects(assertOrder(changed, config, order.buyer), /terms commitment/i);
  const changedProvider = { ...order, provider: address() };
  await assert.rejects(assertOrder(changedProvider, config, order.buyer), /trusted payment configuration/i);
});

test('independent review: another submitted result or a duplicated manifest path cannot be approved', async () => {
  const { order, job } = await submittedFixture();
  await assert.rejects(assertResult(order, { ...job, resultHash: 'ab'.repeat(32) }), /matching submitted result/i);
  const duplicate = structuredClone(order);
  duplicate.manifest!.artifacts[0]!.path = 'listing.json';
  duplicate.resultHash = await hashCanonical(duplicate.manifest);
  await assert.rejects(assertResult(duplicate, { ...job, resultHash: duplicate.resultHash }), /manifest is incomplete/i);
});

test('independent review: downloaded ZIP rejects a valid-CRC substituted payload, hidden file, trailing data or altered directory', async () => {
  const { order, files } = await submittedFixture();
  const bytes = zipBundle(files);
  await verifyBundle(buffer(bytes), order.manifest!, order.resultHash!);
  const alteredPayload = zipBundle({ ...files, 'listing.json': jsonBytes({ ...order.listing!, title: 'Substituted after release' }) });
  await assert.rejects(verifyBundle(buffer(alteredPayload), order.manifest!, order.resultHash!), /does not match/i);
  const hiddenFile = zipBundle({ ...files, 'hidden.json': jsonBytes({ uncommitted: true }) });
  await assert.rejects(verifyBundle(buffer(hiddenFile), order.manifest!, order.resultHash!), /does not match/i);
  const trailingData = Buffer.concat([bytes, Buffer.from('trailing uncommitted bytes')]);
  await assert.rejects(verifyBundle(buffer(trailingData), order.manifest!, order.resultHash!), /does not match/i);
  const directory = Buffer.from(bytes);
  const start = directory.readUInt32LE(directory.length - 6);
  directory.writeUInt32LE(1, start + 42);
  await assert.rejects(verifyBundle(buffer(directory), order.manifest!, order.resultHash!), /does not match/i);
});

test('independent review: browser refuses substituted preview bytes, dimensions, source roles and animated containers', async () => {
  const { order, job, previewFiles } = await submittedFixture();
  const entry = order.manifest!.previews[0]!;
  await verifyPreviewBytes(buffer(previewFiles.hero!), entry, 'hero', 'image/webp');
  const replacement = await sharp({ create: { width: 64, height: 64, channels: 3, background: '#ff0000' } }).webp().toBuffer();
  await assert.rejects(verifyPreviewBytes(buffer(replacement), entry, 'hero', 'image/webp'), /preview bytes differ/i);
  await assert.rejects(verifyPreviewBytes(buffer(previewFiles.hero!), { ...entry, width: 63 }, 'hero', 'image/webp'), /preview dimensions differ/i);
  const changedRole = structuredClone(order);
  changedRole.manifest!.previews[0]!.sourcePath = 'social-story.webp';
  changedRole.resultHash = await hashCanonical(changedRole.manifest);
  await assert.rejects(assertResult(changedRole, { ...job, resultHash: changedRole.resultHash }), /preview metadata differs/i);
  const animated = Buffer.from(previewFiles.hero!);
  animated.write('ANIM', 12, 4, 'ascii');
  await assert.rejects(verifyPreviewBytes(buffer(animated), { ...entry, sha256: sha256(animated), bytes: animated.length }, 'hero', 'image/webp'), /single-frame WebP/i);
});
