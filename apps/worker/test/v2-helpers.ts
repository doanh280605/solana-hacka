import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { deriveJobV2Address, type Job } from '@holdfast/chain';
import { FixtureAiProvider, type AiProvider, type AiRequest } from '../src/ai.js';
import { createWorker } from '../src/app.js';
import type { Order, WorkerSettings } from '../src/types.js';
import type { Listing, OrderV2 } from '../src/v2-types.js';
import { FixtureChain, multipartPayload, signature, smallPng, walletFixture, type WalletFixture } from './helpers.js';

export const ORIGIN = 'http://localhost:5173';
export const BRIEF = 'Blue ceramic cup with a curved handle. Keep the product unchanged and use a warm studio background.';
export class V2Chain extends FixtureChain {
  submissions = 0;
  failSubmission = false;
  constructor() { super(); this.config.provider = walletFixture().address; }
  deriveJobV2(buyer: string, id: string): string { return deriveJobV2Address(this.config, buyer, id).toBase58(); }
  fundV2(order: OrderV2): Job {
    const job = super.fund({ ...order, status: 'quoted' });
    Object.assign(job, { version: 2, provider: order.provider, quoteExpiresAt: order.quoteExpiresAt,
      inputHash: order.inputHash, specHash: order.specHash, termsHash: order.termsHash, resultHash: '0'.repeat(64), submittedAt: 0 });
    return job;
  }
  override settle(order: Order | OrderV2, state: 'Released' | 'Refunded'): void { super.settle({ ...order, status: 'quoted' }, state); }
  async submitResult(address: string, hash: string, persist: (bytes: string, signature: string) => Promise<void>, existing?: string): Promise<string> {
    this.submissions++;
    if (!existing) await persist('fixture-signed-bytes', 'fixture-submission-signature');
    if (this.failSubmission) throw new Error('Fixture RPC did not confirm submission');
    const job = this.jobs.get(address)!;
    if (job.state !== 'Funded') throw new Error('Unexpected duplicate submission');
    job.state = 'Submitted'; job.resultHash = hash; job.submittedAt = this.now;
    return 'fixture-submission-signature';
  }
}
export class CountingAi extends FixtureAiProvider {
  interpretations = 0; listings = 0; edits = 0;
  override async interpret(request: AiRequest): Promise<{ productFacts: string[]; imageDirection: string }> { this.interpretations++; return super.interpret(request); }
  override async listing(request: AiRequest): Promise<Listing> { this.listings++; return super.listing(request); }
  override async edit(request: AiRequest): Promise<Buffer> { this.edits++; return super.edit(request); }
}
export async function v2Fixture(ai: AiProvider = new CountingAi()) {
  const chain = new V2Chain();
  const buyer = walletFixture(); const other = walletFixture();
  const settings: WorkerSettings = {
    dataDir: await mkdtemp(join(tmpdir(), 'osid-v2-')), orderLifetimeSeconds: 120, challengeLifetimeSeconds: 60,
    challengeDomain: 'http://localhost:8787', corsOrigins: [ORIGIN], aiMode: 'fixture',
    executionLifetimeSeconds: 1800, quoteLifetimeSeconds: 600, allowRehearsalStall: true, maxQuotesPerHour: 100,
  };
  const worker = await createWorker({ chain, settings, ai, logger: false });
  return { ...worker, chain, settings, buyer, other, ai,
    async cleanup() { await worker.app.close(); await rm(settings.dataDir, { recursive: true, force: true }); } };
}
export type V2Fixture = Awaited<ReturnType<typeof v2Fixture>>;
export interface Login { headers: Record<string, string>; cookie: string; csrfToken: string; wallet: string }
export async function login(fixture: Pick<V2Fixture, 'app'>, wallet: WalletFixture): Promise<Login> {
  const nonceResponse = await fixture.app.inject({ method: 'POST', url: '/api/auth/nonce', headers: { origin: ORIGIN }, payload: { wallet: wallet.address } });
  if (nonceResponse.statusCode !== 200) throw new Error(nonceResponse.body);
  const nonce = nonceResponse.json<{ nonce: string; message: string }>();
  const response = await fixture.app.inject({ method: 'POST', url: '/api/auth/verify', headers: { origin: ORIGIN },
    payload: { wallet: wallet.address, nonce: nonce.nonce, signature: signature(wallet, nonce.message) } });
  if (response.statusCode !== 200) throw new Error(response.body);
  const session = response.json<{ csrfToken: string; wallet: string }>();
  const cookie = String(response.headers['set-cookie']).split(';')[0]!;
  return { cookie, csrfToken: session.csrfToken, wallet: session.wallet,
    headers: { cookie, origin: ORIGIN, 'x-osid-csrf': session.csrfToken } };
}
export async function quote(f: V2Fixture, auth: Login, mode = 'normal'): Promise<OrderV2> {
  const multipart = multipartPayload(auth.wallet, mode, await smallPng(), [['brief', BRIEF]]);
  const response = await f.app.inject({ method: 'POST', url: '/api/v2/orders', ...multipart, headers: { ...multipart.headers, ...auth.headers } });
  if (response.statusCode !== 201) throw new Error(`${response.statusCode} ${response.body}`);
  return response.json<OrderV2>();
}
export async function ready(f: V2Fixture, auth: Login): Promise<OrderV2> {
  const order = await quote(f, auth); f.chain.fundV2(order);
  const notified = await f.app.inject({ method: 'POST', url: `/api/v2/orders/${order.jobId}/funded`, headers: auth.headers, payload: { signature: 'fixture-hint' } });
  if (notified.statusCode !== 200) throw new Error(notified.body);
  await f.productService.waitForIdle();
  const response = await f.app.inject({ method: 'GET', url: `/api/v2/orders/${order.jobId}`, headers: auth.headers });
  const result = response.json<OrderV2>();
  if (result.status !== 'ready') throw new Error(response.body);
  return result;
}
