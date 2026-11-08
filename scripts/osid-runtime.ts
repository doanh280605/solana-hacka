import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { createHash, createPrivateKey, sign } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { relative, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { Keypair } from '@solana/web3.js';
import { canonicalJson, hashCanonical, type PublicConfig } from '@holdfast/chain';
import type { OrderV2, ResultManifest } from '../apps/worker/src/v2-types.js';
import { ROOT } from './common.js';

export type { OrderV2 };
export function hash(bytes: Uint8Array): string { return createHash('sha256').update(bytes).digest('hex'); }
export function signMessage(wallet: Keypair, message: string): string {
  const key = createPrivateKey({ key: Buffer.concat([Buffer.from('302e020100300506032b657004220420', 'hex'), Buffer.from(wallet.secretKey.subarray(0, 32))]), type: 'pkcs8', format: 'der' });
  return sign(null, Buffer.from(message), key).toString('base64');
}
export async function until<T>(label: string, check: () => Promise<T | undefined | false>, timeoutMs = 120_000): Promise<T> {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    const result = await check();
    if (result) return result;
    await delay(700);
  }
  throw new Error(`Timed out: ${label}`);
}
export async function portUnused(port: number): Promise<void> {
  for (const host of ['127.0.0.1', '::1']) {
    await new Promise<void>((accept, reject) => {
      const probe = createServer();
      probe.once('error', (error: NodeJS.ErrnoException) => {
        if (host === '::1' && ['EAFNOSUPPORT', 'EADDRNOTAVAIL'].includes(error.code ?? '')) accept();
        else reject(new Error(`Cannot reserve ${host}:${port} (${error.code}); existing processes are never stopped`));
      });
      probe.listen(port, host, () => probe.close(error => error ? reject(error) : accept()));
    });
  }
}
export interface ProcessRecord { name: string; pid?: number; startedAt: string; stopRequestedAt?: string; exit?: { at: string; code: number | null; signal: NodeJS.Signals | null }; logFile: string }
export interface OwnedProcess { child: ChildProcess; record: ProcessRecord; output: string }
export async function startProcess(name: string, args: string[], env: NodeJS.ProcessEnv, directory: string, cwd = ROOT): Promise<OwnedProcess> {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const logFile = resolve(directory, `${name}.log`);
  const child = spawn(process.execPath, args, { cwd, env, stdio: ['ignore', 'pipe', 'pipe'] });
  const handle: OwnedProcess = { child, record: { name, pid: child.pid, startedAt: new Date().toISOString(), logFile: relative(ROOT, logFile) }, output: '' };
  const capture = (chunk: Buffer) => { handle.output = (handle.output + chunk.toString()).slice(-100_000); };
  child.stdout?.on('data', capture); child.stderr?.on('data', capture);
  child.on('error', error => { handle.output += `Process error: ${error.message}`; });
  child.once('exit', (code, signal) => { handle.record.exit = { at: new Date().toISOString(), code, signal }; });
  return handle;
}
export async function saveProcessLog(handle: OwnedProcess): Promise<void> { await writeFile(resolve(ROOT, handle.record.logFile), handle.output, { mode: 0o600 }); }
export async function stopProcess(handle?: OwnedProcess): Promise<void> {
  if (!handle) return;
  if (!handle.record.exit) {
    handle.record.stopRequestedAt = new Date().toISOString();
    assert(handle.child.kill('SIGTERM'), `Unable to stop owned ${handle.record.name}`);
    try { await until('owned process exit', async () => handle.record.exit, 12_000); }
    catch { handle.child.kill('SIGKILL'); await until('owned process forced exit', async () => handle.record.exit, 5000); }
  }
  await saveProcessLog(handle);
}
export async function health(handle: OwnedProcess, origin: string): Promise<void> {
  await until('server healthy', async () => {
    if (handle.record.exit) throw new Error(`${handle.record.name} exited: ${handle.output.slice(-3000)}`);
    try { return (await fetch(origin, { signal: AbortSignal.timeout(1500) })).ok; } catch { return false; }
  }, 120_000);
}
function errorCode(error: unknown): string {
  if (error && typeof error === 'object') {
    if ('code' in error && typeof error.code === 'string') return error.code;
    if ('cause' in error) return errorCode(error.cause);
  }
  return String(error);
}
export async function assertOffline(handle: OwnedProcess, origin: string) {
  assert(handle.record.exit, 'A recorded worker exit is required');
  try { await fetch(`${origin}/health`, { signal: AbortSignal.timeout(2000) }); throw new Error('API still responds'); }
  catch (error) { assert.equal(errorCode(error), 'ECONNREFUSED'); }
  return { at: new Date().toISOString(), pid: handle.record.pid, exit: handle.record.exit, health: 'ECONNREFUSED' };
}
export async function startWorker(config: PublicConfig, directory: string, workerPort: number, webOrigin: string, fixture: boolean, lifetime = 1800): Promise<OwnedProcess> {
  await portUnused(workerPort);
  const origin = `http://127.0.0.1:${workerPort}`;
  const worker = await startProcess('worker', ['--env-file=.env', '--import', 'tsx', 'apps/worker/src/index.ts'], {
    ...process.env, RPC_URL: config.rpcUrl, PROGRAM_ID: config.programId, MINT: config.mint, MERCHANT: config.merchant,
    PROVIDER: config.provider, PROVIDER_KEYPAIR_PATH: resolve(ROOT, '.local/keys/provider.json'), CLUSTER: config.cluster,
    WORKER_HOST: '127.0.0.1', WORKER_PORT: String(workerPort), WORKER_PUBLIC_ORIGIN: origin,
    WORKER_DATA_DIR: resolve(directory, 'worker-data'), CORS_ORIGINS: webOrigin,
    AI_MODE: fixture ? 'fixture' : 'live', OSID_ORDER_LIFETIME_SECONDS: String(lifetime),
    OSID_ALLOW_REHEARSAL_STALL: 'true',
    OSID_QUOTE_LIFETIME_SECONDS: String(Math.min(600, lifetime - 5)), CHALLENGE_LIFETIME_SECONDS: '120',
  }, directory);
  try {
    await health(worker, `${origin}/health`);
    const served = await fetch(`${origin}/api/config`).then(r => r.json());
    assert.deepEqual(served, config);
    return worker;
  } catch (error) { await stopProcess(worker); throw error; }
}

export class ApiClient {
  cookie = '';
  csrf = '';
  constructor(readonly origin: string, readonly webOrigin: string) {}
  async response(path: string, options: RequestInit = {}): Promise<Response> {
    const headers = new Headers(options.headers);
    headers.set('Origin', this.webOrigin);
    if (this.cookie) headers.set('Cookie', this.cookie);
    if (this.csrf && options.method && options.method !== 'GET') headers.set('X-Osid-CSRF', this.csrf);
    return fetch(`${this.origin}${path}`, { ...options, headers, signal: options.signal ?? AbortSignal.timeout(300_000) });
  }
  async json<T>(path: string, options: RequestInit = {}): Promise<T> {
    const response = await this.response(path, options);
    if (!response.ok) throw new Error(`HTTP ${response.status} ${path}: ${(await response.text()).slice(0,1000)}`);
    return response.json() as Promise<T>;
  }
  async post<T>(path: string, body: unknown): Promise<T> { return this.json<T>(path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }); }
  async login(wallet: Keypair) {
    const buyer = wallet.publicKey.toBase58();
    const nonce = await this.post<{ nonce: string; message: string; expiresAt: number }>('/api/auth/nonce', { wallet: buyer });
    assert(nonce.message.includes(new URL(this.webOrigin).host)); assert(nonce.message.includes('no payment authorization'));
    const body = { wallet: buyer, nonce: nonce.nonce, signature: signMessage(wallet, nonce.message) };
    const response = await this.response('/api/auth/verify', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    assert.equal(response.status, 200, await response.clone().text());
    const cookie = response.headers.get('set-cookie'); assert(cookie); assert(cookie.includes('HttpOnly')); assert(cookie.includes('SameSite=Lax'));
    this.cookie = cookie.split(';')[0]!;
    const session = await response.json() as { wallet: string; expiresAt: number; csrfToken: string };
    assert.equal(session.wallet, buyer); this.csrf = session.csrfToken;
    const replay = await this.response('/api/auth/verify', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    assert.equal(replay.status, 401);
    return { wallet: buyer, expiresAt: session.expiresAt, replayRejected: true, httpOnly: true, sameSite: 'Lax' };
  }
  async quote(wallet: Keypair, input: Buffer, mode: 'normal' | 'stall' = 'normal'): Promise<OrderV2> {
    const form = new FormData(); form.set('buyer', wallet.publicKey.toBase58()); form.set('mode', mode);
    form.set('brief', 'Morning candle. Cedar and amber scent. 250 g amber glass jar with a black lid and a cream label reading Morning. Keep the exact jar, lid, color and label. Warm neutral studio background for a small shop. Do not add certifications, burn time, safety promises, prices or other product facts.');
    form.set('file', new Blob([new Uint8Array(input)], { type: 'image/png' }), 'candle.png');
    return this.json<OrderV2>('/api/v2/orders', { method: 'POST', body: form });
  }
  async download(order: OrderV2, wallet: Keypair): Promise<Buffer> {
    const buyer = wallet.publicKey.toBase58();
    const challenge = await this.post<{ nonce: string; message: string }>('/api/v2/orders/' + order.jobId + '/challenge', { buyer });
    const body = { buyer, nonce: challenge.nonce, signature: signMessage(wallet, challenge.message) };
    const options = { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) };
    const response = await this.response(`/api/v2/orders/${order.jobId}/download`, options);
    if (response.status !== 200) throw new Error(`Download HTTP ${response.status}: ${await response.text()}`);
    assert.equal(response.headers.get('cache-control'), 'no-store');
    const bytes = Buffer.from(await response.arrayBuffer());
    const replay = await this.response(`/api/v2/orders/${order.jobId}/download`, options); assert.equal(replay.status, 401);
    return bytes;
  }
}

// Independent ZIP parser verifies every payload against the onchain manifest.
// It accepts only the documented fixed pack paths and store-mode entries.
export async function verifyBundle(bytes: Buffer, manifest: ResultManifest, resultHash: string) {
  assert.equal(await hashCanonical(manifest), resultHash);
  const files = new Map<string, Buffer>(); let offset = 0;
  while (offset + 30 <= bytes.length && bytes.readUInt32LE(offset) === 0x04034b50) {
    assert.equal(bytes.readUInt16LE(offset + 8), 0, 'Expected deterministic store-mode ZIP');
    const size = bytes.readUInt32LE(offset + 18), nameSize = bytes.readUInt16LE(offset + 26), extraSize = bytes.readUInt16LE(offset + 28);
    const path = bytes.subarray(offset + 30, offset + 30 + nameSize).toString('utf8');
    const start = offset + 30 + nameSize + extraSize;
    assert(!files.has(path)); assert(!path.includes('..') && !path.includes('/')); assert(start + size <= bytes.length);
    files.set(path, bytes.subarray(start, start + size)); offset = start + size;
  }
  assert.equal(files.size, 7);
  assert.deepEqual(JSON.parse(files.get('manifest.json')!.toString()), manifest);
  assert.equal(files.get('manifest.json')!.toString(), canonicalJson(manifest));
  assert.equal(manifest.artifacts.length, 6);
  for (const entry of manifest.artifacts) { const payload = files.get(entry.path); assert(payload); assert.equal(payload.length, entry.size); assert.equal(hash(payload), entry.sha256); }
  const listing = JSON.parse(files.get('listing.json')!.toString()) as { title: string; description: string; bullets: string[] };
  assert(listing.title.length > 0 && listing.title.length <= 80); assert(listing.description.length > 0 && listing.description.length <= 1200);
  assert.equal(listing.bullets.length, 5); assert(listing.bullets.every(b => b.length > 0 && b.length <= 180));
  const validation = JSON.parse(files.get('validation.json')!.toString()); assert.equal(validation.passed, true);
  const { default: sharp } = await import('sharp');
  for (const [name, width, height] of [['hero.webp',1600,1600],['social-square.webp',1080,1080],['social-portrait.webp',1080,1350],['social-story.webp',1080,1920]] as const) {
    const metadata = await sharp(files.get(name)!).metadata(); assert.equal(metadata.format, 'webp'); assert.equal(metadata.width, width); assert.equal(metadata.height, height);
  }
  return { sha256: hash(bytes), bytes: bytes.length, manifestHash: resultHash, files: [...files.keys()], artifactHashesVerified: true, dimensionsVerified: true, copyLimitsVerified: true, validationPassed: true };
}
export async function verifyPreviews(api: ApiClient, order: OrderV2) {
  assert(order.manifest && order.resultHash && order.previews?.length === 4);
  assert.equal(await hashCanonical(order.manifest), order.resultHash);
  assert.equal(order.manifest.previews.length, 4);
  const { default: sharp } = await import('sharp');
  const verified = [];
  for (const name of ['hero', 'portrait', 'square', 'story']) {
    const entry: ResultManifest['previews'][number] | undefined = order.manifest.previews.find(p => p.path === `preview-${name}.webp`);
    assert(entry); assert.equal(entry.sourcePath, name === 'hero' ? 'hero.webp' : `social-${name}.webp`);
    const response = await api.response(`/api/v2/orders/${order.jobId}/preview/${name}`);
    assert.equal(response.status, 200); assert.equal(response.headers.get('cache-control'), 'no-store');
    assert.equal(response.headers.get('content-type'), 'image/webp');
    const bytes = Buffer.from(await response.arrayBuffer()); assert.equal(bytes.length, entry.bytes); assert.equal(hash(bytes), entry.sha256);
    const metadata = await sharp(bytes).metadata(); assert.equal(metadata.format, 'webp'); assert.equal(metadata.width, entry.width); assert.equal(metadata.height, entry.height);
    verified.push({ path: entry.path, sha256: entry.sha256, bytes: bytes.length, width: metadata.width, height: metadata.height });
  }
  return { boundToResultHash: order.resultHash, verified };
}
export async function sampleInput(): Promise<Buffer> {
  try { return await readFile(resolve(ROOT, 'apps/web/public/sample-before.png')); }
  catch {
    const { default: sharp } = await import('sharp');
    try { return await sharp(await readFile(resolve(ROOT, 'apps/web/public/sample-before.webp'))).png().toBuffer(); }
    catch { /* The source-code fixture also permits offline fresh-checkout tests. */ }
    return sharp(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="1000" height="1000"><rect width="1000" height="1000" fill="#d6d4d0"/><ellipse cx="510" cy="820" rx="230" ry="40" fill="#b8b5b0"/><rect x="330" y="245" width="340" height="550" rx="45" fill="#704127"/><rect x="320" y="215" width="360" height="85" rx="18" fill="#242424"/><rect x="366" y="425" width="268" height="220" rx="3" fill="#eee8d7"/><text x="500" y="510" text-anchor="middle" font-family="serif" font-size="40" fill="#292922">Morning</text><text x="500" y="558" text-anchor="middle" font-family="sans-serif" font-size="16" fill="#292922">CEDAR &amp; AMBER</text><text x="500" y="605" text-anchor="middle" font-family="sans-serif" font-size="15" fill="#292922">250 g</text></svg>')).png().toBuffer();
  }
}
