import assert from 'node:assert/strict';
import { test } from 'node:test';
import sharp from 'sharp';
import { buildImages, specification } from '../../worker/src/pack.js';
import { committedPreviews, verifyPreviewBytes, webpDimensions } from '../src/previews.js';
import { hashBytes } from '../src/bytes.js';
import type { Manifest, PreviewCommitment } from '../src/types.js';

const spec = specification('A simple amber glass candle with a black lid and cream label.', [], 'Keep the product unchanged in a warm studio.');
const image = await sharp({ create: { width: 50, height: 50, channels: 3, background: '#967147' } }).webp().toBuffer();
const generated = await buildImages(image, spec);
const entries: PreviewCommitment[] = await Promise.all(Object.entries(generated.previews).map(async ([name, value]) => ({ path: `preview-${name}.webp`, sourcePath: name === 'hero' ? 'hero.webp' : `social-${name}.webp`, sha256: await hashBytes(value.bytes.buffer.slice(value.bytes.byteOffset, value.bytes.byteOffset + value.bytes.byteLength) as ArrayBuffer), bytes: value.bytes.length, width: value.manifest.width, height: value.manifest.height, mimeType: 'image/webp' as const })));
entries.sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
const manifest: Manifest = { schemaVersion: 2, jobId: 'a'.repeat(64), jobAddress: 'job', termsHash: 'b'.repeat(64), specHash: 'c'.repeat(64), inputHash: 'd'.repeat(64), artifacts: [], previews: entries };
const displayed = Object.entries(generated.previews).map(([name, value]) => ({ name, url: `/api/v2/orders/${manifest.jobId}/preview/${name}`, width: value.manifest.width, height: value.manifest.height }));
const buffer = (name: string) => { const bytes = generated.previews[name]!.bytes; return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer; };

test('browser verifies all four real worker-produced private previews', async () => {
  assert.equal(committedPreviews(manifest, displayed).length, 4);
  for (const entry of entries) {
    const name = entry.path.slice(8, -5);
    await verifyPreviewBytes(buffer(name), entry, name, 'image/webp');
    assert.deepEqual(webpDimensions(buffer(name)), { width: entry.width, height: entry.height });
  }
});

test('changed preview bytes, byte length and response MIME fail closed', async () => {
  const entry = entries[0]!;
  const changed = new Uint8Array(buffer('hero')); changed[changed.length - 1] ^= 1;
  await assert.rejects(verifyPreviewBytes(changed.buffer, entry, 'hero', 'image/webp'), /preview bytes differ/);
  await assert.rejects(verifyPreviewBytes(buffer('hero').slice(0, -1), entry, 'hero', 'image/webp'), /preview bytes differ/);
  await assert.rejects(verifyPreviewBytes(buffer('hero'), entry, 'hero', 'image/png'), /preview bytes differ/);
});

test('changed dimensions cannot be accepted through mutable public preview metadata', async () => {
  const changed = structuredClone(displayed); changed.find(p => p.name === 'hero')!.width--;
  assert.throws(() => committedPreviews(manifest, changed), /metadata differs/);
  await assert.rejects(verifyPreviewBytes(buffer('hero'), { ...entries[0]!, width: entries[0]!.width - 1 }, 'hero', 'image/webp'), /dimensions differ/);
});

test('missing, duplicate, reordered or relabeled preview commitments are rejected', () => {
  assert.throws(() => committedPreviews({ ...manifest, previews: entries.slice(1) }, displayed), /complete four-image/);
  assert.throws(() => committedPreviews({ ...manifest, previews: [entries[0]!, entries[0]!, ...entries.slice(2)] }, displayed), /complete four-image/);
  assert.throws(() => committedPreviews({ ...manifest, previews: [...entries].reverse() }, displayed), /complete four-image/);
  assert.throws(() => committedPreviews({ ...manifest, previews: [{ ...entries[0]!, sourcePath: 'social-story.webp' }, ...entries.slice(1)] }, displayed), /metadata differs/);
});

test('an invalid or animated WebP is rejected even if its hash and size are committed', async () => {
  const invalid = new TextEncoder().encode('not a WebP container').buffer;
  await assert.rejects(verifyPreviewBytes(invalid, { ...entries[0]!, bytes: invalid.byteLength, sha256: await hashBytes(invalid) }, 'hero', 'image/webp'), /single-frame WebP/);
  const original = Buffer.from(buffer('hero'));
  const animated = Buffer.alloc(original.length + 18); original.copy(animated, 0, 0, 12);
  animated.write('VP8X', 12); animated.writeUInt32LE(10, 16); animated[20] = 0x02;
  animated.writeUIntLE(entries[0]!.width - 1, 24, 3); animated.writeUIntLE(entries[0]!.height - 1, 27, 3);
  original.copy(animated, 30, 12); animated.writeUInt32LE(animated.length - 8, 4);
  const bytes = animated.buffer.slice(animated.byteOffset, animated.byteOffset + animated.byteLength) as ArrayBuffer;
  await assert.rejects(verifyPreviewBytes(bytes, { ...entries[0]!, bytes: bytes.byteLength, sha256: await hashBytes(bytes) }, 'hero', 'image/webp'), /single-frame WebP/);
});
