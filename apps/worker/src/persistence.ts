import { randomBytes } from 'node:crypto';
import { mkdir, open, readFile, readdir, rename, rm } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { HttpError, isMissing } from './errors.js';
import { JOB_ID_PATTERN, type ImageManifest, type StoredOrder } from './types.js';
import { sha256 } from './security.js';

const IMAGE_FILES = { input: 'input.png', output: 'result.webp', preview: 'preview.webp' } as const;
export type ImageKind = keyof typeof IMAGE_FILES;

/** Same-filesystem rename plus fsync: readers see either old or complete new bytes. */
export async function atomicWrite(path: string, bytes: Uint8Array): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.${randomBytes(12).toString('hex')}.tmp`;
  let handle;
  try {
    handle = await open(temporary, 'wx', 0o600);
    await handle.writeFile(bytes);
    await handle.sync();
    await handle.close();
    handle = undefined;
    await rename(temporary, path);
    const directory = await open(dirname(path), 'r');
    try { await directory.sync(); } finally { await directory.close(); }
  } catch (error) {
    await handle?.close().catch(() => undefined);
    await rm(temporary, { force: true }).catch(() => undefined);
    throw error;
  }
}

function validManifest(value: unknown): value is ImageManifest {
  if (!value || typeof value !== 'object') return false;
  const data = value as Record<string, unknown>;
  return typeof data.sha256 === 'string' && /^[0-9a-f]{64}$/.test(data.sha256)
    && Number.isSafeInteger(data.size) && Number(data.size) > 0
    && Number.isSafeInteger(data.width) && Number(data.width) > 0
    && Number.isSafeInteger(data.height) && Number(data.height) > 0;
}

function validStoredOrder(value: unknown, jobId: string): value is StoredOrder {
  if (!value || typeof value !== 'object') return false;
  const order = value as Record<string, unknown>;
  return order.version === 1 && order.jobId === jobId && JOB_ID_PATTERN.test(jobId)
    && ['jobAddress', 'buyer', 'merchant', 'mint'].every(key => typeof order[key] === 'string' && /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(order[key] as string))
    && typeof order.amount === 'string' && /^[1-9][0-9]*$/.test(order.amount)
    && Number.isSafeInteger(order.expiresAt)
    && Number.isSafeInteger(order.createdAt) && Number.isSafeInteger(order.updatedAt)
    && ['normal', 'stall'].includes(String(order.mode))
    && ['quoted', 'funded', 'processing', 'ready', 'released', 'refunded', 'failed'].includes(String(order.status))
    && validManifest(order.input)
    && (order.output === undefined || validManifest(order.output))
    && (order.preview === undefined || validManifest(order.preview))
    && (order.fundingVerified === undefined || typeof order.fundingVerified === 'boolean')
    && (order.chainState === undefined || ['Funded', 'Released', 'Refunded'].includes(String(order.chainState)))
    && (order.error === undefined || typeof order.error === 'string')
    && Array.isArray(order.challenges) && order.challenges.length <= 8
    && order.challenges.every(challenge => challenge && typeof challenge === 'object'
      && typeof challenge.nonce === 'string' && /^[0-9a-f]{64}$/.test(challenge.nonce)
      && typeof challenge.message === 'string' && challenge.message.length < 2048
      && Number.isSafeInteger(challenge.expiresAt) && typeof challenge.used === 'boolean');
}

export class OrderStore {
  constructor(readonly root: string) {}

  private directory(jobId: string): string {
    if (!JOB_ID_PATTERN.test(jobId)) throw new HttpError(400, 'Invalid job ID');
    return join(this.root, 'orders', jobId);
  }

  async initialize(): Promise<void> {
    await mkdir(join(this.root, 'orders'), { recursive: true, mode: 0o700 });
  }

  async listIds(): Promise<string[]> {
    const entries = await readdir(join(this.root, 'orders'), { withFileTypes: true });
    return entries.filter(entry => entry.isDirectory() && JOB_ID_PATTERN.test(entry.name)).map(entry => entry.name).sort();
  }

  async read(jobId: string): Promise<StoredOrder> {
    let bytes: Buffer;
    try { bytes = await readFile(join(this.directory(jobId), 'order.json')); }
    catch (error) {
      if (isMissing(error)) throw new HttpError(404, 'Order not found');
      throw error;
    }
    let value: unknown;
    try { value = JSON.parse(bytes.toString('utf8')); }
    catch { throw new HttpError(500, 'Stored order metadata is invalid'); }
    if (!validStoredOrder(value, jobId)) throw new HttpError(500, 'Stored order metadata is invalid');
    return value;
  }

  async save(order: StoredOrder): Promise<void> {
    if (!validStoredOrder(order, order.jobId)) throw new Error('Refusing to persist invalid order');
    order.updatedAt = Math.floor(Date.now() / 1000);
    await atomicWrite(join(this.directory(order.jobId), 'order.json'), Buffer.from(JSON.stringify(order, null, 2)));
  }

  async writeImage(jobId: string, kind: ImageKind, bytes: Buffer): Promise<void> {
    await atomicWrite(join(this.directory(jobId), IMAGE_FILES[kind]), bytes);
  }

  async readImage(jobId: string, kind: ImageKind, manifest: ImageManifest): Promise<Buffer> {
    let bytes: Buffer;
    try { bytes = await readFile(join(this.directory(jobId), IMAGE_FILES[kind])); }
    catch (error) {
      if (isMissing(error)) throw new HttpError(503, 'Stored file is unavailable');
      throw error;
    }
    if (bytes.length !== manifest.size || sha256(bytes) !== manifest.sha256) {
      throw new HttpError(503, 'Stored file integrity check failed');
    }
    return bytes;
  }
}

/** Serializes updates to one order, including challenge consumption and processing. */
export class OrderLocks {
  private readonly tails = new Map<string, Promise<void>>();

  async run<T>(jobId: string, operation: () => Promise<T>): Promise<T> {
    const previous = this.tails.get(jobId) ?? Promise.resolve();
    let release!: () => void;
    const current = new Promise<void>(resolve => { release = resolve; });
    this.tails.set(jobId, current);
    await previous;
    try { return await operation(); }
    finally {
      release();
      if (this.tails.get(jobId) === current) this.tails.delete(jobId);
    }
  }
}
