import { randomBytes } from 'node:crypto';
import type { Job } from '@holdfast/chain';
import { HttpError } from './errors.js';
import { convertPng, validatePng } from './images.js';
import { OrderLocks, OrderStore } from './persistence.js';
import { newChallenge, verifyWalletSignature } from './security.js';
import { TOKEN_PROGRAM, type ChainGateway, type Mode, type Order, type StoredOrder, type WorkerSettings } from './types.js';

type LogError = (error: unknown, message: string) => void;

export class WorkerService {
  readonly store: OrderStore;
  private readonly locks = new OrderLocks();
  private readonly tasks = new Map<string, Promise<void>>();
  private closing = false;

  constructor(readonly chain: ChainGateway, readonly settings: WorkerSettings, private readonly logError: LogError = () => undefined) {
    this.store = new OrderStore(settings.dataDir);
  }

  async initialize(): Promise<void> {
    await this.store.initialize();
    // Startup reconciliation resumes jobs whose process died after funding or
    // after writing output but before publishing its metadata.
    for (const jobId of await this.store.listIds()) {
      try { await this.read(jobId); }
      catch (error) { this.logError(error, `Could not reconcile stored job ${jobId}; a later request can retry`); }
    }
  }

  validateBuyer(buyer: unknown): asserts buyer is string {
    if (typeof buyer !== 'string' || !this.chain.validateAddress(buyer)) throw new HttpError(400, 'buyer must be a Solana public key');
  }

  private publicOrder(order: StoredOrder): Order {
    return {
      jobId: order.jobId,
      jobAddress: order.jobAddress,
      buyer: order.buyer,
      merchant: order.merchant,
      mint: order.mint,
      amount: order.amount,
      expiresAt: order.expiresAt,
      mode: order.mode,
      status: order.status,
      ...((order.status === 'ready' || order.status === 'released') && order.output && order.preview
        ? { previewUrl: `/api/orders/${order.jobId}/preview` } : {}),
      ...(order.error ? { error: order.error } : {}),
    };
  }

  async create(buyer: unknown, mode: unknown, bytes: Buffer): Promise<Order> {
    this.validateBuyer(buyer);
    if (mode !== 'normal' && mode !== 'stall') throw new HttpError(400, 'mode must be normal or stall');
    const input = await validatePng(bytes);
    let now: number;
    try { now = await this.chain.getTime(); }
    catch { throw new HttpError(503, 'Finalized chain time is unavailable; retry before funding'); }
    if (!Number.isSafeInteger(now) || now < 1) throw new HttpError(503, 'Finalized chain time is unavailable');
    const jobId = randomBytes(32).toString('hex');
    const order: StoredOrder = {
      version: 1,
      jobId,
      jobAddress: this.chain.deriveJob(buyer, jobId),
      buyer,
      merchant: this.chain.config.merchant,
      mint: this.chain.config.mint,
      amount: this.chain.config.amount,
      expiresAt: now + this.settings.orderLifetimeSeconds,
      mode: mode as Mode,
      status: 'quoted',
      createdAt: Math.floor(Date.now() / 1000),
      updatedAt: Math.floor(Date.now() / 1000),
      input,
      challenges: [],
    };
    // An acknowledged order always has its input and quote on durable disk.
    await this.store.writeImage(jobId, 'input', bytes);
    await this.store.save(order);
    return this.publicOrder(order);
  }

  private async finalizedJob(order: StoredOrder, required: boolean): Promise<Job | null> {
    let job: Job | null;
    try { job = await this.chain.readJob(order.jobAddress); }
    catch { throw new HttpError(503, 'Finalized chain state is unavailable; retry shortly'); }
    if (!job) {
      if (required || order.fundingVerified) throw new HttpError(409, 'No finalized funded job exists for this quote');
      return null;
    }
    if (order.merchant !== this.chain.config.merchant || order.mint !== this.chain.config.mint || order.amount !== this.chain.config.amount
      || order.jobAddress !== this.chain.deriveJob(order.buyer, order.jobId)
      || job.address !== order.jobAddress || job.buyer !== order.buyer || job.merchant !== order.merchant
      || job.mint !== order.mint || job.jobId !== order.jobId || job.amount !== order.amount
      || job.expiresAt !== order.expiresAt || job.vault !== this.chain.deriveVault(order.jobAddress)
      || !['Funded', 'Released', 'Refunded'].includes(job.state)) {
      throw new HttpError(409, 'Finalized onchain job does not match this stored quote');
    }
    let vault;
    try { vault = await this.chain.readVault(job.vault); }
    catch { throw new HttpError(503, 'Finalized vault state is unavailable; retry shortly'); }
    if (!vault || vault.address !== job.vault || !vault.initialized || vault.programOwner !== TOKEN_PROGRAM
      || vault.authority !== job.address || vault.mint !== order.mint || !/^\d+$/.test(vault.amount)
      || (job.state === 'Funded' && BigInt(vault.amount) < BigInt(order.amount))) {
      throw new HttpError(409, 'Finalized escrow vault does not hold the quoted deposit with the expected mint and authority');
    }
    return job;
  }

  private async hasPersistedResult(order: StoredOrder): Promise<boolean> {
    if (!order.output || !order.preview) return false;
    try {
      await this.store.readImage(order.jobId, 'output', order.output);
      await this.store.readImage(order.jobId, 'preview', order.preview);
      return true;
    } catch (error) {
      if (!(error instanceof HttpError) || error.statusCode !== 503) throw error;
      // Recover from a missing/corrupt result using the durable input. No preview
      // is advertised until both files are present and their hashes match.
      delete order.output;
      delete order.preview;
      return false;
    }
  }

  private async reconcile(order: StoredOrder, fundingRequired = false): Promise<StoredOrder> {
    const job = await this.finalizedJob(order, fundingRequired);
    if (!job) return order;
    order.fundingVerified = true;
    order.chainState = job.state;
    delete order.error;
    if (job.state === 'Refunded') {
      order.status = 'refunded';
    } else {
      const ready = await this.hasPersistedResult(order);
      if (ready) order.status = job.state === 'Released' ? 'released' : 'ready';
      else if (order.mode === 'stall') order.status = job.state === 'Released' ? 'released' : 'funded';
      else {
        order.status = 'processing';
        this.schedule(order.jobId);
      }
    }
    await this.store.save(order);
    return order;
  }

  async read(jobId: string, fundingRequired = false): Promise<Order> {
    return this.locks.run(jobId, async () => this.publicOrder(await this.reconcile(await this.store.read(jobId), fundingRequired)));
  }

  async list(buyer: unknown): Promise<Order[]> {
    this.validateBuyer(buyer);
    const orders: Order[] = [];
    for (const jobId of await this.store.listIds()) {
      const stored = await this.store.read(jobId);
      if (stored.buyer === buyer) orders.push(await this.read(jobId));
    }
    return orders.sort((a, b) => b.expiresAt - a.expiresAt);
  }

  private schedule(jobId: string): void {
    if (this.closing || this.tasks.has(jobId)) return;
    // The order lock guarantees processing sees the quote update saved by the
    // current request. No conversion starts from an HTTP signature alone.
    const task = this.locks.run(jobId, async () => {
      const order = await this.store.read(jobId);
      if (order.mode === 'stall') return;
      const job = await this.finalizedJob(order, true);
      if (!job || job.state === 'Refunded') return;
      if (await this.hasPersistedResult(order)) return;
      order.status = 'processing';
      await this.store.save(order);
      const input = await this.store.readImage(jobId, 'input', order.input);
      const converted = await convertPng(input);
      // The original is persisted first. Its path never appears in public JSON.
      await this.store.writeImage(jobId, 'output', converted.output);
      await this.store.writeImage(jobId, 'preview', converted.preview);
      order.output = converted.outputManifest;
      order.preview = converted.previewManifest;
      // Persist the manifest before publishing readiness; a restart can safely
      // reconcile this intermediate state if the RPC fails next.
      await this.store.save(order);
      const latest = await this.finalizedJob(order, true);
      order.chainState = latest?.state;
      order.status = latest?.state === 'Refunded' ? 'refunded' : latest?.state === 'Released' ? 'released' : 'ready';
      delete order.error;
      await this.store.save(order);
    }).catch(async error => {
      this.logError(error, `Conversion did not complete for job ${jobId}`);
      await this.locks.run(jobId, async () => {
        const order = await this.store.read(jobId);
        order.status = 'failed';
        order.error = error instanceof HttpError && error.statusCode === 503
          ? 'Chain or storage temporarily unavailable; refresh to retry'
          : 'Conversion failed; refresh to retry or reclaim the deposit after expiry';
        await this.store.save(order);
      }).catch(saveError => this.logError(saveError, `Could not persist failure for job ${jobId}`));
    }).finally(() => { this.tasks.delete(jobId); });
    this.tasks.set(jobId, task);
  }

  async preview(jobId: string): Promise<Buffer> {
    return this.locks.run(jobId, async () => {
      const order = await this.reconcile(await this.store.read(jobId));
      if (!['ready', 'released'].includes(order.status) || !order.output || !order.preview) throw new HttpError(409, 'Watermarked preview is not ready');
      return this.store.readImage(jobId, 'preview', order.preview);
    });
  }

  private async releasedOrder(jobId: string, buyer: unknown): Promise<StoredOrder> {
    this.validateBuyer(buyer);
    const order = await this.store.read(jobId);
    if (buyer !== order.buyer) throw new HttpError(403, 'Only the original buyer can unlock this file');
    const job = await this.finalizedJob(order, true);
    if (job?.state !== 'Released') throw new HttpError(403, 'Finalized buyer approval is required to download');
    if (!await this.hasPersistedResult(order)) {
      if (order.mode === 'normal') this.schedule(jobId);
      throw new HttpError(409, 'The stored result is not ready; refresh to retry');
    }
    order.status = 'released';
    order.chainState = 'Released';
    order.fundingVerified = true;
    return order;
  }

  async challenge(jobId: string, buyer: unknown): Promise<{ message: string; nonce: string; expiresAt: number }> {
    return this.locks.run(jobId, async () => {
      const order = await this.releasedOrder(jobId, buyer);
      const now = Math.floor(Date.now() / 1000);
      // Issuance is public: a caller knowing the buyer address must not be able
      // to evict a pending buyer signature or extend its authorization window.
      const active = order.challenges.find(item => !item.used && item.expiresAt > now);
      if (active) return { message: active.message, nonce: active.nonce, expiresAt: active.expiresAt };
      const challenge = newChallenge(order, this.settings.challengeDomain, now + this.settings.challengeLifetimeSeconds);
      order.challenges = [challenge];
      await this.store.save(order);
      return { message: challenge.message, nonce: challenge.nonce, expiresAt: challenge.expiresAt };
    });
  }

  async download(jobId: string, buyer: unknown, nonce: unknown, signature: unknown): Promise<Buffer> {
    return this.locks.run(jobId, async () => {
      const order = await this.releasedOrder(jobId, buyer);
      const challenge = typeof nonce === 'string' ? order.challenges.find(item => item.nonce === nonce) : undefined;
      if (!challenge || challenge.used || challenge.expiresAt <= Math.floor(Date.now() / 1000)) {
        throw new HttpError(401, 'Download challenge is invalid, expired, or already used');
      }
      if (!verifyWalletSignature(this.chain.publicKeyBytes(order.buyer), challenge.message, signature)) {
        throw new HttpError(401, 'Buyer wallet signature is invalid');
      }
      const bytes = await this.store.readImage(jobId, 'output', order.output!);
      // Persist consumption before any bytes are returned. The lock also
      // prevents simultaneous duplicate requests from both succeeding.
      challenge.used = true;
      await this.store.save(order);
      return bytes;
    });
  }

  async waitForIdle(): Promise<void> {
    while (this.tasks.size) await Promise.all([...this.tasks.values()]);
  }

  async close(): Promise<void> {
    this.closing = true;
    await this.waitForIdle();
  }
}
