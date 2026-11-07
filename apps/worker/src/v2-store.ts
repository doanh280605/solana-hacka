import { mkdir, readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { HttpError, isMissing } from './errors.js';
import { atomicWrite } from './persistence.js';
import { sha256 } from './security.js';
import { JOB_ID_PATTERN } from './types.js';
import type { StoredV2 } from './v2-types.js';

const FILES = new Set(['input.bin', 'ai-edit.bin', 'hero.webp', 'social-square.webp', 'social-portrait.webp',
  'social-story.webp', 'listing.json', 'validation.json', 'manifest.json', 'bundle.zip',
  'preview-hero.webp', 'preview-square.webp', 'preview-portrait.webp', 'preview-story.webp']);
export class V2Store {
  constructor(readonly root: string) {}
  private directory(id: string): string {
    if (!JOB_ID_PATTERN.test(id)) throw new HttpError(400, 'Invalid job ID');
    return join(this.root, 'orders-v2', id);
  }
  private file(id: string, name: string): string {
    if (!FILES.has(name)) throw new Error('Invalid private artifact name');
    return join(this.directory(id), name);
  }
  async initialize(): Promise<void> { await mkdir(join(this.root, 'orders-v2'), { recursive: true, mode: 0o700 }); }
  async listIds(): Promise<string[]> {
    return (await readdir(join(this.root, 'orders-v2'), { withFileTypes: true }))
      .filter(e => e.isDirectory() && JOB_ID_PATTERN.test(e.name)).map(e => e.name).sort();
  }
  async read(id: string): Promise<StoredV2> {
    let value: unknown;
    try { value = JSON.parse(await readFile(join(this.directory(id), 'order.json'), 'utf8')); }
    catch (error) {
      if (isMissing(error)) throw new HttpError(404, 'Order not found');
      throw new HttpError(503, 'Stored order metadata is unavailable');
    }
    if (!value || typeof value !== 'object') throw new HttpError(503, 'Stored order metadata is invalid');
    const order = value as StoredV2;
    if (order.version !== 2 || order.jobId !== id || !Array.isArray(order.challenges) || !Array.isArray(order.attempts)
      || !['jobAddress', 'buyer', 'merchant', 'provider', 'mint'].every(k => typeof (order as unknown as Record<string, unknown>)[k] === 'string')
      || !['inputHash', 'specHash', 'termsHash'].every(k => /^[0-9a-f]{64}$/.test(String((order as unknown as Record<string, unknown>)[k])))
      || !Number.isSafeInteger(order.expiresAt) || !Number.isSafeInteger(order.quoteExpiresAt)
      || !order.input || order.input.sha256 !== order.inputHash || !Number.isSafeInteger(order.input.size)
      || !order.specification || order.specification.schemaVersion !== 2 || typeof order.quoteAccepted !== 'boolean'
      || !['quoted', 'funded', 'processing', 'submitting', 'ready', 'released', 'refunded', 'failed'].includes(order.status)
      || !['live', 'fixture'].includes(order.aiMode) || !['normal', 'stall'].includes(order.mode)
      || !/^[1-9][0-9]*$/.test(order.amount)) throw new HttpError(503, 'Stored order metadata is invalid');
    return order;
  }
  async save(order: StoredV2): Promise<void> {
    order.updatedAt = Math.floor(Date.now() / 1000);
    await atomicWrite(join(this.directory(order.jobId), 'order.json'), Buffer.from(JSON.stringify(order)));
  }
  async write(id: string, name: string, bytes: Buffer): Promise<void> { await atomicWrite(this.file(id, name), bytes); }
  async readFile(id: string, name: string, expected: { sha256: string; size: number }): Promise<Buffer> {
    let bytes: Buffer;
    try { bytes = await readFile(this.file(id, name)); }
    catch (error) { if (isMissing(error)) throw new HttpError(503, 'A durable artifact is unavailable; do not approve payment'); throw error; }
    if (bytes.length !== expected.size || sha256(bytes) !== expected.sha256) throw new HttpError(503, 'Durable artifact integrity check failed; do not approve payment');
    return bytes;
  }
}
