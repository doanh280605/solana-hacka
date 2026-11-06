import { createHash, generateKeyPairSync, sign, type KeyObject } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CHECKOUT_IDL, PublicKey, type Job, type PublicConfig } from '@holdfast/chain';
import sharp from 'sharp';
import { createWorker, type WorkerApp } from '../src/app.js';
import { TOKEN_PROGRAM, type ChainGateway, type Order, type VaultSnapshot, type WorkerSettings } from '../src/types.js';

export interface WalletFixture { address: string; bytes: Uint8Array; privateKey: KeyObject }

export function walletFixture(): WalletFixture {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  const bytes = publicKey.export({ format: 'der', type: 'spki' }).subarray(-32);
  return { address: new PublicKey(bytes).toBase58(), bytes, privateKey };
}

function hashAddress(text: string): string {
  return new PublicKey(createHash('sha256').update(text).digest()).toBase58();
}

/** Deliberate chain fixture. These tests do not provide local-validator/Devnet evidence. */
export class FixtureChain implements ChainGateway {
  readonly config: PublicConfig = {
    rpcUrl: 'http://127.0.0.1:8899',
    programId: CHECKOUT_IDL.address,
    mint: hashAddress('mint'),
    merchant: hashAddress('merchant'),
    decimals: 6,
    amount: '5000000',
    cluster: 'localnet',
  };
  readonly jobs = new Map<string, Job>();
  readonly vaults = new Map<string, VaultSnapshot>();
  offline = false;
  now = Math.floor(Date.now() / 1000);
  validateAddress(address: string): boolean {
    try { return new PublicKey(address).toBase58() === address; } catch { return false; }
  }
  deriveJob(buyer: string, jobId: string): string { return hashAddress(`job:${buyer}:${jobId}`); }
  deriveVault(jobAddress: string): string { return hashAddress(`vault:${jobAddress}`); }
  publicKeyBytes(address: string): Uint8Array { return new PublicKey(address).toBytes(); }
  async getTime(): Promise<number> {
    if (this.offline) throw new Error('Fixture RPC is offline');
    return this.now;
  }
  async readJob(address: string): Promise<Job | null> {
    if (this.offline) throw new Error('Fixture RPC is offline');
    return structuredClone(this.jobs.get(address) ?? null);
  }
  async readVault(address: string): Promise<VaultSnapshot | null> {
    if (this.offline) throw new Error('Fixture RPC is offline');
    return structuredClone(this.vaults.get(address) ?? null);
  }
  fund(order: Order): Job {
    const vault = this.deriveVault(order.jobAddress);
    const job: Job = {
      address: order.jobAddress,
      buyer: order.buyer,
      merchant: order.merchant,
      mint: order.mint,
      jobId: order.jobId,
      amount: order.amount,
      expiresAt: order.expiresAt,
      state: 'Funded',
      vault,
    };
    this.jobs.set(order.jobAddress, job);
    this.vaults.set(vault, {
      address: vault,
      programOwner: TOKEN_PROGRAM,
      mint: order.mint,
      authority: order.jobAddress,
      amount: order.amount,
      initialized: true,
    });
    return job;
  }
  settle(order: Order, state: 'Released' | 'Refunded'): void {
    this.jobs.get(order.jobAddress)!.state = state;
    this.vaults.get(this.deriveVault(order.jobAddress))!.amount = '0';
  }
}

export function multipartPayload(buyer: string, mode: string, file: Buffer, extras: [string, string][] = []): { payload: Buffer; headers: Record<string, string> } {
  const boundary = 'holdfast-fixture-boundary';
  const fields = [['buyer', buyer], ['mode', mode], ...extras];
  const prefix = fields.map(([name, value]) => `--${boundary}\r\nContent-Disposition: form-data; name="${name}"\r\n\r\n${value}\r\n`).join('')
    + `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="../../private.png"\r\nContent-Type: image/png\r\n\r\n`;
  return {
    payload: Buffer.concat([Buffer.from(prefix), file, Buffer.from(`\r\n--${boundary}--\r\n`)]),
    headers: { 'content-type': `multipart/form-data; boundary=${boundary}` },
  };
}

export async function smallPng(): Promise<Buffer> {
  return sharp({ create: { width: 128, height: 96, channels: 4, background: '#17b2c8' } }).png().toBuffer();
}

export interface WorkerFixture extends WorkerApp {
  chain: FixtureChain;
  buyer: WalletFixture;
  other: WalletFixture;
  settings: WorkerSettings;
  cleanup(): Promise<void>;
}

export async function workerFixture(): Promise<WorkerFixture> {
  const chain = new FixtureChain();
  const buyer = walletFixture();
  const other = walletFixture();
  const dataDir = await mkdtemp(join(tmpdir(), 'holdfast-worker-'));
  const settings: WorkerSettings = {
    dataDir, orderLifetimeSeconds: 120, challengeLifetimeSeconds: 60,
    challengeDomain: 'http://localhost:8787', corsOrigins: ['http://localhost:5173'],
  };
  const worker = await createWorker({ chain, settings, logger: false });
  return {
    ...worker, chain, buyer, other, settings,
    async cleanup() { await worker.app.close(); await rm(dataDir, { recursive: true, force: true }); },
  };
}

export async function createOrder(fixture: WorkerFixture, mode = 'normal'): Promise<Order> {
  const response = await fixture.app.inject({ method: 'POST', url: '/api/orders', ...multipartPayload(fixture.buyer.address, mode, await smallPng()) });
  if (response.statusCode !== 201) throw new Error(`Create failed: ${response.statusCode} ${response.body}`);
  return response.json<Order>();
}

export async function readyOrder(fixture: WorkerFixture): Promise<Order> {
  const order = await createOrder(fixture);
  fixture.chain.fund(order);
  const funded = await fixture.app.inject({ method: 'POST', url: `/api/orders/${order.jobId}/funded`, payload: {} });
  if (funded.statusCode !== 200) throw new Error(`Fund notification failed: ${funded.body}`);
  await fixture.service.waitForIdle();
  return (await fixture.app.inject({ method: 'GET', url: `/api/orders/${order.jobId}` })).json<Order>();
}

export function signature(wallet: WalletFixture, message: string): string {
  return sign(null, Buffer.from(message), wallet.privateKey).toString('base64');
}
