import { randomBytes } from 'node:crypto';
import sharp from 'sharp';
import { computeTermsHash, type Job } from '@holdfast/chain';
import { createAiProvider, ProviderFailure, type AiProvider, type AiRequest } from './ai.js';
import { HttpError } from './errors.js';
import { buildImages, jsonBytes, specification, validInterpretation, validListing, validatePack, validateProductImage, zipBundle } from './pack.js';
import { OrderLocks } from './persistence.js';
import { sha256, verifyWalletSignature } from './security.js';
import { TOKEN_PROGRAM, type ChainGateway, type Mode, type WorkerSettings } from './types.js';
import { V2Store } from './v2-store.js';
import type { Attempt, Listing, ManifestPreview, OrderV2, ResultManifest, Stage, StoredV2 } from './v2-types.js';

type LogError = (error: unknown, message: string) => void;
const PAYLOAD_NAMES = ['hero.webp', 'listing.json', 'social-portrait.webp', 'social-square.webp', 'social-story.webp', 'validation.json'];
const PREVIEW_SOURCES: Record<string, string> = {
  'preview-hero.webp': 'hero.webp',
  'preview-portrait.webp': 'social-portrait.webp',
  'preview-square.webp': 'social-square.webp',
  'preview-story.webp': 'social-story.webp',
};
export class ProductService {
  readonly store: V2Store;
  readonly ai: AiProvider;
  private readonly locks = new OrderLocks();
  private readonly tasks = new Map<string, Promise<void>>();
  private readonly capacityQueue: ((granted: boolean) => void)[] = [];
  private activeAi = 0;
  private closing = false;
  constructor(readonly chain: ChainGateway, readonly settings: WorkerSettings, private readonly log: LogError = () => undefined, ai?: AiProvider) {
    this.store = new V2Store(settings.dataDir);
    this.ai = ai ?? createAiProvider(settings);
  }
  private acquireCapacity(): Promise<boolean> {
    if (this.closing) return Promise.resolve(false);
    if (this.activeAi < (this.settings.maxConcurrentGenerations ?? 2)) {
      this.activeAi++;
      return Promise.resolve(true);
    }
    return new Promise(resolve => this.capacityQueue.push(resolve));
  }
  private releaseCapacity(): void {
    // Hand the occupied slot directly to the oldest acknowledged funded job.
    // Its quote/chain record is durable; initialize() reconstructs this queue on restart.
    const next = this.closing ? undefined : this.capacityQueue.shift();
    if (next) next(true);
    else this.activeAi--;
  }
  async initialize(): Promise<void> {
    await this.chain.validateProviderSigner?.();
    await this.store.initialize();
    for (const id of await this.store.listIds()) {
      try {
        await this.locks.run(id, async () => {
          const order = await this.store.read(id);
          if (!order.quoteAccepted) {
            for (const attempt of order.attempts) if (attempt.state === 'pending') {
              attempt.state = 'uncertain'; attempt.error = 'Quote creation was interrupted; provider response ID retained for manual reconciliation';
            }
            order.status = 'failed'; order.error = 'Quote creation interrupted before acceptance. No funded obligation was created';
            await this.store.save(order);
          } else await this.reconcile(order);
        });
      } catch (error) { this.log(error, `Could not reconcile V2 order ${id}`); }
    }
  }
  private checkBuyer(wallet: unknown): asserts wallet is string {
    if (typeof wallet !== 'string' || !this.chain.validateAddress(wallet)) throw new HttpError(400, 'buyer must be a Solana public key');
  }
  private public(order: StoredV2): OrderV2 {
    const ready = ['ready', 'released'].includes(order.status);
    return {
      version: 2, jobId: order.jobId, jobAddress: order.jobAddress, buyer: order.buyer, merchant: order.merchant,
      provider: order.provider, mint: order.mint, amount: order.amount, expiresAt: order.expiresAt, quoteExpiresAt: order.quoteExpiresAt,
      inputHash: order.inputHash, specHash: order.specHash, termsHash: order.termsHash, specification: order.specification,
      aiMode: order.aiMode, mode: order.mode, status: order.status,
      ...(order.resultHash ? { resultHash: order.resultHash } : {}),
      ...(ready && order.manifest ? { manifest: order.manifest, validation: order.validation, listing: order.listing,
        previews: order.manifest.previews.map(preview => {
          const name = preview.path.slice('preview-'.length, -'.webp'.length);
          return { name, width: preview.width, height: preview.height, url: `/api/v2/orders/${order.jobId}/preview/${name}` };
        }) } : {}),
      ...(order.submissionSignature ? { submissionSignature: order.submissionSignature } : {}),
      attempts: order.attempts.map(({ id, stage, startedAt, state, provider, completedAt, requestId, providerId }) =>
        ({ id, stage, startedAt, state, provider, ...(completedAt ? { completedAt } : {}), ...(requestId ? { requestId } : {}), ...(providerId ? { providerId } : {}) })),
      ...(order.error ? { error: order.error } : {}),
    };
  }
  private async terms(order: StoredV2): Promise<string> {
    return computeTermsHash({ programId: this.chain.config.programId, jobAddress: order.jobAddress, jobId: order.jobId,
      buyer: order.buyer, merchant: order.merchant, provider: order.provider, mint: order.mint, amount: order.amount,
      expiresAt: order.expiresAt, quoteExpiresAt: order.quoteExpiresAt, inputHash: order.inputHash, specHash: order.specHash });
  }
  async create(wallet: string, buyer: unknown, mode: unknown, brief: unknown, bytes: Buffer): Promise<OrderV2> {
    this.checkBuyer(buyer);
    if (buyer !== wallet) throw new HttpError(403, 'The signed-in wallet must be the buyer');
    if (mode !== 'normal' && mode !== 'stall') throw new HttpError(400, 'mode must be normal or stall');
    if (mode === 'stall' && !this.settings.allowRehearsalStall) throw new HttpError(400, 'Stall mode is available only in an explicitly configured rehearsal');
    if (typeof brief !== 'string' || brief.trim().length < 20 || brief.length > 2000 || /[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(brief)) throw new HttpError(400, 'Write a brief of 20–2000 characters');
    const provider = this.chain.config.provider;
    if (!provider || !this.chain.deriveJobV2 || !this.chain.submitResult) throw new HttpError(503, 'The V2 provider signer is not configured');
    if (provider === buyer) throw new HttpError(400, 'The provider wallet cannot be used as a buyer');
    if (!this.ai.available()) throw new HttpError(503, 'Live AI is not configured. Configure OPENAI_API_KEY on the worker; try the labeled sample demo');
    const validated = await validateProductImage(bytes);
    return this.locks.run(`quote:${wallet}`, async () => {
      const now = Math.floor(Date.now() / 1000);
      let recent = 0;
      for (const id of await this.store.listIds()) {
        const old = await this.store.read(id);
        if (old.buyer === wallet && old.createdAt > now - 3600) recent++;
      }
      if (recent >= (this.settings.maxQuotesPerHour ?? 6)) throw new HttpError(429, 'Quote limit reached; try again in an hour');
      if (this.activeAi >= (this.settings.maxConcurrentGenerations ?? 2)) throw new HttpError(429, 'Generation capacity is busy; retry shortly');
      this.activeAi++;
      try {
      let chainNow: number;
      try { chainNow = await this.chain.getTime(); } catch { throw new HttpError(503, 'Finalized chain time is unavailable'); }
      const jobId = randomBytes(32).toString('hex');
      const order: StoredV2 = {
        version: 2, jobId, jobAddress: this.chain.deriveJobV2!(buyer, jobId), buyer, merchant: this.chain.config.merchant,
        mint: this.chain.config.mint, provider, amount: this.chain.config.amount, mode: mode as Mode, status: 'quoted',
        expiresAt: chainNow + (this.settings.executionLifetimeSeconds ?? 1800), quoteExpiresAt: chainNow + (this.settings.quoteLifetimeSeconds ?? 600),
        input: validated.manifest, inputHash: validated.manifest.sha256, inputMediaType: validated.mediaType,
        specHash: '0'.repeat(64), termsHash: '0'.repeat(64), specification: specification(brief, [], 'Awaiting AI interpretation'),
        aiMode: this.ai.mode, createdAt: now, updatedAt: now, quoteAccepted: false, challenges: [], attempts: [],
      };
      await this.store.write(jobId, 'input.bin', bytes);
      await this.store.save(order);
      try {
        const interpreted = await this.stage(order, 'specification', bytes) as { productFacts: string[]; imageDirection: string };
        order.specification = specification(brief, interpreted.productFacts, interpreted.imageDirection);
        order.specHash = sha256(jsonBytes(order.specification));
        // Quote validity begins after interpretation, distinct from the longer execution deadline.
        chainNow = await this.chain.getTime();
        order.quoteExpiresAt = chainNow + (this.settings.quoteLifetimeSeconds ?? 600);
        order.expiresAt = chainNow + (this.settings.executionLifetimeSeconds ?? 1800);
        order.termsHash = await this.terms(order); order.quoteAccepted = true;
        await this.store.save(order);
        return this.public(order);
      } catch (error) {
        order.status = 'failed'; order.error = error instanceof HttpError ? error.message : 'Quote creation failed before funding';
        await this.store.save(order);
        throw error;
      }
      } finally { this.releaseCapacity(); }
    });
  }
  private async owned(id: string, wallet: string): Promise<StoredV2> {
    const order = await this.store.read(id);
    if (order.buyer !== wallet) throw new HttpError(403, 'Only the original buyer can access this order');
    if (!order.quoteAccepted) throw new HttpError(409, 'This quote was never accepted by the service');
    return order;
  }
  private async finalized(order: StoredV2, required = false): Promise<Job | null> {
    if (!this.chain.deriveJobV2 || order.jobAddress !== this.chain.deriveJobV2(order.buyer, order.jobId)
      || sha256(jsonBytes(order.specification)) !== order.specHash || await this.terms(order) !== order.termsHash) throw new HttpError(409, 'Stored specification commitment does not match this quote');
    let job: Job | null;
    try { job = await this.chain.readJob(order.jobAddress); }
    catch { throw new HttpError(503, 'Finalized chain state is unavailable'); }
    if (!job) {
      if (required || order.fundingVerified) throw new HttpError(409, 'No finalized V2 funded job exists for this quote');
      return null;
    }
    if (job.version !== 2 || job.address !== order.jobAddress || job.buyer !== order.buyer || job.merchant !== order.merchant
      || job.provider !== order.provider || job.mint !== order.mint || job.amount !== order.amount || job.expiresAt !== order.expiresAt
      || job.quoteExpiresAt !== order.quoteExpiresAt || job.jobId !== order.jobId || job.inputHash !== order.inputHash || job.specHash !== order.specHash
      || job.termsHash !== order.termsHash || job.vault !== this.chain.deriveVault(order.jobAddress)
      || order.merchant !== this.chain.config.merchant || order.provider !== this.chain.config.provider || order.mint !== this.chain.config.mint || order.amount !== this.chain.config.amount
      || !['Funded', 'Submitted', 'Released', 'Refunded'].includes(job.state)) throw new HttpError(409, 'Finalized onchain job does not match the exact V2 quote');
    if (['Submitted', 'Released'].includes(job.state) && (!order.resultHash || job.resultHash !== order.resultHash)) throw new HttpError(409, 'Submitted result does not match the durable result commitment');
    let vault;
    try { vault = await this.chain.readVault(job.vault); } catch { throw new HttpError(503, 'Finalized vault state is unavailable'); }
    if (!vault || vault.address !== job.vault || !vault.initialized || vault.programOwner !== TOKEN_PROGRAM || vault.authority !== job.address
      || vault.mint !== order.mint || !/^\d+$/.test(vault.amount) || (['Funded', 'Submitted'].includes(job.state) && BigInt(vault.amount) < BigInt(order.amount))) throw new HttpError(409, 'Finalized escrow vault does not hold the exact recorded mint and authority with sufficient deposit');
    return job;
  }
  private committedPreviews(order: StoredV2): ManifestPreview[] {
    const previews = order.manifest?.previews;
    if (!Array.isArray(previews) || previews.length !== 4
      || previews.map(preview => preview?.path).join(',') !== Object.keys(PREVIEW_SOURCES).join(',')) throw new HttpError(409, 'Committed preview manifest is missing or incomplete');
    for (const preview of previews) {
      const name = preview.path.slice('preview-'.length, -'.webp'.length);
      const metadata = order.previewFiles?.[name];
      if (Object.keys(preview).sort().join(',') !== 'bytes,height,mimeType,path,sha256,sourcePath,width'
        || preview.sourcePath !== PREVIEW_SOURCES[preview.path] || preview.mimeType !== 'image/webp'
        || !/^[0-9a-f]{64}$/.test(preview.sha256) || !Number.isSafeInteger(preview.bytes) || preview.bytes < 1 || preview.bytes > 5 * 1024 * 1024
        || !Number.isSafeInteger(preview.width) || preview.width < 1 || preview.width > 560
        || !Number.isSafeInteger(preview.height) || preview.height < 1 || preview.height > 680
        || !metadata || metadata.sha256 !== preview.sha256 || metadata.size !== preview.bytes
        || metadata.width !== preview.width || metadata.height !== preview.height) throw new HttpError(409, 'Preview metadata differs from the committed result manifest');
    }
    return previews;
  }
  private async durablePack(order: StoredV2): Promise<Buffer> {
    if (!order.manifest || !order.resultHash || !order.bundle || !order.validation?.passed || !order.listing || !order.previewFiles
      || Object.keys(order.previewFiles).sort().join(',') !== 'hero,portrait,square,story') throw new HttpError(503, 'The complete durable result is unavailable; do not approve payment');
    const manifest = order.manifest;
    if (manifest.schemaVersion !== 2 || manifest.jobId !== order.jobId || manifest.jobAddress !== order.jobAddress
      || manifest.termsHash !== order.termsHash || manifest.specHash !== order.specHash || manifest.inputHash !== order.inputHash
      || sha256(jsonBytes(manifest)) !== order.resultHash || !Array.isArray(manifest.artifacts)
      || manifest.artifacts.map(a => a.path).join(',') !== PAYLOAD_NAMES.join(',')) throw new HttpError(409, 'Result manifest commitment is invalid');
    const previews = this.committedPreviews(order);
    const files: Record<string, Buffer> = {};
    for (const entry of manifest.artifacts) files[entry.path] = await this.store.readFile(order.jobId, entry.path, entry);
    if (!files['listing.json']!.equals(jsonBytes(order.listing)) || !files['validation.json']!.equals(jsonBytes(order.validation))) throw new HttpError(409, 'Review data differs from committed artifact bytes');
    const manifestBytes = jsonBytes(manifest);
    await this.store.readFile(order.jobId, 'manifest.json', { sha256: order.resultHash, size: manifestBytes.length });
    files['manifest.json'] = manifestBytes;
    for (const preview of previews) {
      const bytes = await this.store.readFile(order.jobId, preview.path, { sha256: preview.sha256, size: preview.bytes });
      const metadata = await sharp(bytes).metadata();
      if (metadata.format !== 'webp' || metadata.width !== preview.width || metadata.height !== preview.height || (metadata.pages ?? 1) !== 1) throw new HttpError(503, 'Preview image dimensions or format differ from the committed manifest');
    }
    const bundle = await this.store.readFile(order.jobId, 'bundle.zip', order.bundle);
    // Rebuild deterministic store-mode ZIP: final bytes must contain exactly the committed payloads.
    if (!bundle.equals(zipBundle(files))) throw new HttpError(503, 'Bundle differs from the committed artifacts');
    return bundle;
  }
  private async reconcile(order: StoredV2, required = false): Promise<StoredV2> {
    const job = await this.finalized(order, required);
    if (!job) return order;
    order.fundingVerified = true; order.chainState = job.state;
    if (job.state === 'Refunded') order.status = 'refunded';
    else if (['Submitted', 'Released'].includes(job.state)) {
      await this.durablePack(order);
      order.status = job.state === 'Released' ? 'released' : 'ready'; delete order.error;
    } else if (order.mode === 'stall') order.status = 'funded';
    else {
      const blocked = order.attempts.some(a => a.state === 'failed' || ((a.state === 'uncertain' || a.state === 'pending') && !(a.providerId && a.stage !== 'image')));
      const now = await this.chain.getTime();
      if (now >= order.expiresAt) {
        order.status = 'failed'; order.error = 'Execution deadline passed. Recover the deposit with your buyer wallet';
      } else if (blocked) {
        order.status = 'failed'; order.error ??= 'A provider attempt needs reconciliation. It will not be regenerated automatically; a refund becomes available at the deadline';
      } else {
        order.status = order.resultHash ? 'submitting' : 'processing';
        this.schedule(order.jobId);
      }
    }
    await this.store.save(order);
    return order;
  }
  async read(id: string, wallet: string, required = false): Promise<OrderV2> {
    return this.locks.run(id, async () => this.public(await this.reconcile(await this.owned(id, wallet), required)));
  }
  async list(wallet: string): Promise<OrderV2[]> {
    const orders: OrderV2[] = [];
    for (const id of await this.store.listIds()) {
      const order = await this.store.read(id);
      if (order.buyer === wallet && order.quoteAccepted) {
        try { orders.push(await this.read(id, wallet)); }
        catch (error) {
          // History survives RPC/storage outages; never expose readiness without re-verification.
          order.status = 'failed'; order.error = error instanceof HttpError ? error.message : 'Order verification is temporarily unavailable';
          orders.push(this.public(order));
        }
      }
    }
    return orders.sort((a, b) => b.expiresAt - a.expiresAt);
  }
  private async stage(order: StoredV2, stage: Stage, input: Buffer): Promise<unknown> {
    if (order.aiMode !== this.ai.mode) throw new HttpError(503, 'The configured AI mode changed; this order will not be regenerated with another provider mode');
    let attempt = order.attempts.find(a => a.stage === stage);
    if (attempt?.state === 'completed') {
      if (stage === 'listing' && order.listing) return validListing(order.listing, order.specification);
      if (stage === 'image' && order.image) return this.store.readFile(order.jobId, 'ai-edit.bin', order.image);
      if (stage === 'specification') return validInterpretation({ productFacts: order.specification.productFacts, imageDirection: order.specification.imageDirection }, order.specification.brief);
      throw new HttpError(503, 'Completed provider output is missing; automatic regeneration is disabled');
    }
    if (attempt && !(attempt.providerId && stage !== 'image' && ['pending', 'uncertain'].includes(attempt.state))) {
      throw new ProviderFailure(true, 'A prior provider attempt has unknown or failed completion; automatic regeneration is disabled');
    }
    if (!attempt) {
      attempt = { id: randomBytes(16).toString('hex'), stage, startedAt: Math.floor(Date.now() / 1000), state: 'pending', provider: this.ai.mode === 'live' ? 'openai' : 'fixture' };
      order.attempts.push(attempt);
      // This write MUST precede a chargeable request, including quote interpretation.
      await this.store.save(order);
    }
    const current = attempt;
    const request: AiRequest = { attemptId: current.id, stage, brief: order.specification.brief, specification: order.specification,
      input, inputMediaType: order.inputMediaType, ...(current.providerId ? { existingProviderId: current.providerId } : {}),
      identify: async identity => { Object.assign(current, identity); await this.store.save(order); } };
    try {
      let result: unknown;
      if (stage === 'specification') {
        result = validInterpretation(await this.ai.interpret(request), request.brief);
        const value = result as { productFacts: string[]; imageDirection: string };
        order.specification = specification(request.brief, value.productFacts, value.imageDirection);
      } else if (stage === 'listing') {
        result = validListing(await this.ai.listing(request), order.specification); order.listing = result as Listing;
      } else {
        result = await this.ai.edit(request);
        const output = result as Buffer;
        await validateProductImage(output, true);
        await this.store.write(order.jobId, 'ai-edit.bin', output);
        order.image = { sha256: sha256(output), size: output.length };
      }
      current.state = 'completed'; current.completedAt = Math.floor(Date.now() / 1000); delete current.error;
      await this.store.save(order);
      return result;
    } catch (error) {
      current.state = error instanceof ProviderFailure && error.uncertain ? 'uncertain' : 'failed';
      current.error = error instanceof HttpError ? error.message : 'Provider output could not be safely persisted; reconciliation required';
      if (!(error instanceof HttpError)) current.state = 'uncertain';
      await this.store.save(order);
      throw error;
    }
  }
  private schedule(id: string): void {
    if (this.closing || this.tasks.has(id)) return;
    const task = this.acquireCapacity().then(async granted => {
      if (!granted) return;
      try {
      await this.locks.run(id, async () => {
        const order = await this.store.read(id);
        const job = await this.finalized(order, true);
        if (!job || job.state !== 'Funded' || order.mode === 'stall' || await this.chain.getTime() >= order.expiresAt) return;
        order.status = 'processing'; delete order.error; await this.store.save(order);
        if (!order.resultHash) {
          const input = await this.store.readFile(id, 'input.bin', order.input);
          const listing = await this.stage(order, 'listing', input) as Listing;
          const edited = await this.stage(order, 'image', input) as Buffer;
          const images = await buildImages(edited, order.specification);
          const files: Record<string, Buffer> = { ...images.files, 'listing.json': jsonBytes(listing) };
          const validation = await validatePack(files, listing, order.specification);
          if (!validation.passed) throw new HttpError(502, 'Generated pack failed the agreed deterministic acceptance checks');
          files['validation.json'] = jsonBytes(validation);
          const manifest: ResultManifest = { schemaVersion: 2, jobId: id, jobAddress: order.jobAddress, termsHash: order.termsHash,
            specHash: order.specHash, inputHash: order.inputHash, artifacts: Object.keys(files).sort().map(path => ({ path,
              mediaType: path.endsWith('.webp') ? 'image/webp' : 'application/json', size: files[path]!.length, sha256: sha256(files[path]!) })),
            previews: Object.entries(images.previews).map(([name, preview]): ManifestPreview => ({ path: `preview-${name}.webp`,
              sourcePath: PREVIEW_SOURCES[`preview-${name}.webp`]!, sha256: preview.manifest.sha256, bytes: preview.manifest.size,
              width: preview.manifest.width, height: preview.manifest.height, mimeType: 'image/webp' }))
              .sort((left, right) => left.path < right.path ? -1 : left.path > right.path ? 1 : 0) };
          const manifestBytes = jsonBytes(manifest);
          const resultHash = sha256(manifestBytes);
          files['manifest.json'] = manifestBytes;
          for (const [name, bytes] of Object.entries(files)) await this.store.write(id, name, bytes);
          const previewFiles: StoredV2['previewFiles'] = {};
          for (const [name, preview] of Object.entries(images.previews)) {
            await this.store.write(id, `preview-${name}.webp`, preview.bytes); previewFiles[name] = preview.manifest;
          }
          const bundle = zipBundle(files); await this.store.write(id, 'bundle.zip', bundle);
          Object.assign(order, { manifest, resultHash, listing, validation, previewFiles, bundle: { sha256: sha256(bundle), size: bundle.length } });
          // Publish metadata only after every payload, preview and bundle is fsync-durable.
          await this.store.save(order);
        }
        await this.durablePack(order);
        const latest = await this.finalized(order, true);
        if (!latest || latest.state === 'Refunded' || await this.chain.getTime() >= order.expiresAt) {
          order.status = latest?.state === 'Refunded' ? 'refunded' : 'failed'; order.error = 'Deadline passed. Recover the deposit with your buyer wallet';
          await this.store.save(order); return;
        }
        if (latest.state === 'Funded') {
          order.status = 'submitting'; await this.store.save(order);
          if (!this.chain.submitResult) throw new HttpError(503, 'Provider submission signer is unavailable');
          const signature = await this.chain.submitResult(order.jobAddress, order.resultHash!, async (signed, signature) => {
            order.signedSubmission = signed; order.submissionSignature = signature; await this.store.save(order);
          }, order.signedSubmission);
          order.submissionSignature = signature; await this.store.save(order);
        }
        const submitted = await this.finalized(order, true);
        if (!submitted || !['Submitted', 'Released'].includes(submitted.state) || submitted.resultHash !== order.resultHash) throw new HttpError(503, 'Result submission is not finalized yet; refresh to reconcile');
        await this.durablePack(order);
        order.status = submitted.state === 'Released' ? 'released' : 'ready'; order.chainState = submitted.state; delete order.error;
        await this.store.save(order);
      });
      } finally { this.releaseCapacity(); }
    }).catch(async error => {
      this.log(error, `V2 generation or submission did not complete for ${id}`);
      await this.locks.run(id, async () => {
        const order = await this.store.read(id); order.status = 'failed';
        order.error = error instanceof HttpError ? error.message : 'Generation or delivery failed. Existing attempts will not be blindly repeated; recover after the deadline';
        await this.store.save(order);
      }).catch(saveError => this.log(saveError, `Could not persist V2 failure for ${id}`));
    }).finally(() => { this.tasks.delete(id); });
    this.tasks.set(id, task);
  }
  async preview(id: string, name: string, wallet: string): Promise<Buffer> {
    if (!['hero', 'square', 'portrait', 'story'].includes(name)) throw new HttpError(404, 'Preview not found');
    return this.locks.run(id, async () => {
      const order = await this.reconcile(await this.owned(id, wallet));
      if (!['ready', 'released'].includes(order.status)) throw new HttpError(409, 'Submitted durable previews are not ready');
      const preview = this.committedPreviews(order).find(entry => entry.path === `preview-${name}.webp`);
      if (!preview) throw new HttpError(409, 'Requested preview is absent from the committed manifest');
      return this.store.readFile(id, preview.path, { sha256: preview.sha256, size: preview.bytes });
    });
  }
  private async released(id: string, buyer: unknown): Promise<StoredV2> {
    this.checkBuyer(buyer);
    const order = await this.owned(id, buyer);
    const job = await this.finalized(order, true);
    if (job?.state !== 'Released') throw new HttpError(403, 'Finalized buyer approval is required to download');
    await this.durablePack(order);
    order.status = 'released'; order.chainState = 'Released'; return order;
  }
  async challenge(id: string, buyer: unknown): Promise<{ nonce: string; message: string; expiresAt: number }> {
    return this.locks.run(id, async () => {
      const order = await this.released(id, buyer);
      const now = Math.floor(Date.now() / 1000);
      const active = order.challenges.find(c => !c.used && c.expiresAt > now);
      if (active) return { nonce: active.nonce, message: active.message, expiresAt: active.expiresAt };
      const nonce = randomBytes(32).toString('hex');
      const expiresAt = now + this.settings.challengeLifetimeSeconds;
      const message = ['osid private bundle download authorization', `Domain: ${this.settings.challengeDomain}`, 'Purpose: download (no payment authorization)',
        `Buyer: ${order.buyer}`, `Job ID: ${order.jobId}`, `Job address: ${order.jobAddress}`, `Terms hash: ${order.termsHash}`,
        `Result manifest hash: ${order.resultHash}`, `Expires at: ${expiresAt}`, `Nonce: ${nonce}`].join('\n');
      order.challenges = [{ nonce, message, expiresAt, used: false }]; await this.store.save(order);
      return { nonce, message, expiresAt };
    });
  }
  async download(id: string, buyer: unknown, nonce: unknown, signature: unknown): Promise<Buffer> {
    return this.locks.run(id, async () => {
      const order = await this.released(id, buyer);
      const challenge = order.challenges.find(c => c.nonce === nonce);
      if (!challenge || challenge.used || challenge.expiresAt <= Math.floor(Date.now() / 1000)) throw new HttpError(401, 'Download challenge is invalid, expired, or already used');
      if (!verifyWalletSignature(this.chain.publicKeyBytes(order.buyer), challenge.message, signature)) throw new HttpError(401, 'Buyer download signature is invalid');
      const bundle = await this.durablePack(order);
      challenge.used = true; await this.store.save(order);
      return bundle;
    });
  }
  async waitForIdle(): Promise<void> { while (this.tasks.size) await Promise.all([...this.tasks.values()]); }
  async close(): Promise<void> {
    this.closing = true;
    // Queued work has not started a provider attempt. Leave its durable funding
    // record for restart, and let in-flight attempts finish or persist uncertainty.
    for (const waiting of this.capacityQueue.splice(0)) waiting(false);
    await this.waitForIdle();
  }
}
