import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { createHash, createPrivateKey, createPublicKey, randomBytes, sign } from 'node:crypto';
import { mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import {
  PublicKey, buildApproveTransaction, buildFundTransaction, buildRefundTransaction,
  deriveJobAddress, deriveVaultAddress, fetchJob, getConnection, type Job, type Order,
} from '@holdfast/chain';
import type { Keypair } from '@solana/web3.js';
import sharp from 'sharp';
import type { StoredOrder } from '../apps/worker/src/types.js';
import {
  ROOT, assertNetwork, balances, clusterArg, loadConfig, loadKey, requireJob,
  send, txEvidence, waitUntilChain, writeEvidence,
} from './common.js';

type TokenBalances = Awaited<ReturnType<typeof balances>>;
type TransactionEvidence = ReturnType<typeof txEvidence>;
interface ProcessEvidence {
  generation: number;
  pid?: number;
  startedAt: string;
  port: number;
  logFile: string;
  orderLifetimeSeconds: number;
  stopRequestedAt?: string;
  forcedKill?: boolean;
  spawnError?: string;
  exit?: { at: string; code: number | null; signal: NodeJS.Signals | null; observed: true };
}
interface HttpEvidence {
  at: string;
  stage: string;
  method: string;
  path: string;
  status?: number;
  networkError?: string;
}
interface ScenarioEvidence {
  order: Order;
  jobAddress: string;
  vault: string;
  recoveryLink: string;
  before: TokenBalances;
  states: { at: string; state: Job['state'] }[];
  buyerNativeLamports: {
    before: number;
    afterFund?: number;
    afterSettlement?: number;
    rentAndOtherCostsExcludingFees?: number;
    note: string;
  };
  fundingAttempted?: boolean;
  fund?: TransactionEvidence;
  afterFund?: TokenBalances;
  settlementAttempted?: boolean;
  settle?: TransactionEvidence;
  after?: TokenBalances;
  feesLamports?: { fund: number; settlement: number };
  privateAccess?: Record<string, unknown>;
  preApprovalStorage?: Record<string, unknown>;
  restartRecovery?: Record<string, unknown>;
  apiOffline?: Record<string, unknown>;
  observedAtFailure?: Job | null | string;
}
interface RehearsalEvidence {
  schemaVersion: 1;
  runId: string;
  startedAt: string;
  updatedAt: string;
  stage: string;
  cluster: 'localnet' | 'devnet';
  rpcUrl: string;
  genesis?: string;
  programId: string;
  mint: string;
  merchant: string;
  buyer: string;
  secondWallet: string;
  amount: string;
  decimals: 6;
  token: string;
  scope: string;
  dataDir: string;
  workerBaseUrl: string;
  processes: ProcessEvidence[];
  http: HttpEvidence[];
  release?: ScenarioEvidence;
  refund?: ScenarioEvidence;
  passed: boolean;
  error?: string;
  finishedAt?: string;
}
interface WorkerHandle {
  child: ChildProcess;
  record: ProcessEvidence;
  logTail: string;
  stopPromise?: Promise<void>;
}
interface Challenge { message: string; nonce: string; expiresAt: number }

const cluster = clusterArg();
const config = await loadConfig(cluster);
const connection = getConnection(config);
const buyer = await loadKey('buyer');
const secondWallet = await loadKey('attacker');
const runId = `${new Date().toISOString().replace(/[^0-9]/g, '')}-${randomBytes(4).toString('hex')}`;
const dataDirRelative = `.local/rehearsal-${cluster}-${runId}`;
const dataDir = resolve(ROOT, dataDirRelative);
const port = envInteger('REHEARSAL_WORKER_PORT', 18787, 1024, 65535);
const releaseLifetime = envInteger('REHEARSAL_RELEASE_LIFETIME_SECONDS', 300, 60, 86400);
const refundLifetime = envInteger('REHEARSAL_REFUND_LIFETIME_SECONDS', 75, 30, 86400);
const baseUrl = `http://127.0.0.1:${port}`;
const report: RehearsalEvidence = {
  schemaVersion: 1, runId, startedAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
  stage: 'preflight', cluster, rpcUrl: config.rpcUrl, programId: config.programId, mint: config.mint,
  merchant: config.merchant, buyer: buyer.publicKey.toBase58(), secondWallet: secondWallet.publicKey.toBase58(),
  amount: config.amount, decimals: 6, token: 'Mock USDC (test tokens only)',
  scope: 'Real-chain HTTP product rehearsal with a child worker, persisted PNG/WebP, signed download, process restart, and API-offline direct refund. This script does not prove browser wallet UX or constitute a demo recording.',
  dataDir: dataDirRelative, workerBaseUrl: baseUrl, processes: [], http: [], passed: false,
};
let worker: WorkerHandle | undefined;
let interrupted = false;
let inputPng: Buffer;

function envInteger(name: string, fallback: number, min: number, max: number): number {
  const raw = process.env[name] ?? String(fallback);
  const value = Number(raw);
  if (!/^\d+$/.test(raw) || !Number.isSafeInteger(value) || value < min || value > max) {
    throw new Error(`${name} must be an integer between ${min} and ${max}.`);
  }
  return value;
}
function hash(bytes: Uint8Array): string { return createHash('sha256').update(bytes).digest('hex'); }
function assertNotInterrupted(): void { if (interrupted) throw new Error('Rehearsal interrupted. Inspect the progress evidence for recoverable funded jobs.'); }
async function checkpoint(stage?: string): Promise<void> {
  if (stage) report.stage = stage;
  report.updatedAt = new Date().toISOString();
  await writeEvidence(`rehearsal-${cluster}-progress`, report);
  await writeEvidence(`rehearsal-${cluster}-${runId}-progress`, report);
  assertNotInterrupted();
}
function signedMessage(wallet: Keypair, message: string): string {
  // Solana Keypair stores the Ed25519 seed in the first 32 secret-key bytes.
  // Wrap the disposable seed as PKCS#8 for Node's built-in Ed25519 signer.
  const key = createPrivateKey({
    key: Buffer.concat([Buffer.from('302e020100300506032b657004220420', 'hex'), Buffer.from(wallet.secretKey.subarray(0, 32))]),
    type: 'pkcs8', format: 'der',
  });
  assert.deepEqual(createPublicKey(key).export({ type: 'spki', format: 'der' }).subarray(-32), wallet.publicKey.toBuffer());
  return sign(null, Buffer.from(message, 'utf8'), key).toString('base64');
}
function networkErrorCode(error: unknown): string {
  if (error && typeof error === 'object') {
    if ('code' in error && typeof error.code === 'string') return error.code;
    if ('cause' in error) return networkErrorCode(error.cause);
    if ('errors' in error && Array.isArray(error.errors)) return error.errors.map(networkErrorCode).join(',');
  }
  return error instanceof Error ? error.name : String(error);
}
async function http(path: string, init: RequestInit = {}, timeoutMs = 20_000): Promise<Response> {
  assertNotInterrupted();
  const entry: HttpEvidence = { at: new Date().toISOString(), stage: report.stage, method: init.method ?? 'GET', path };
  report.http.push(entry);
  try {
    const response = await fetch(new URL(path, baseUrl), { ...init, signal: AbortSignal.timeout(timeoutMs) });
    entry.status = response.status;
    return response;
  } catch (error) {
    entry.networkError = networkErrorCode(error);
    throw error;
  }
}
async function json<T>(path: string, body?: unknown): Promise<T> {
  const response = await http(path, body === undefined ? {} : {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  });
  if (!response.ok) throw new Error(`${path}: HTTP ${response.status} ${await response.text()}`);
  return response.json() as Promise<T>;
}
async function rejectHttp(path: string, body: unknown, expected: number): Promise<number> {
  const response = await http(path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  const detail = await response.text();
  assert.equal(response.status, expected, `${path}: ${detail}`);
  return response.status;
}
async function assertPortUnused(): Promise<void> {
  await new Promise<void>((resolveResult, reject) => {
    const probe = createServer();
    probe.once('error', () => reject(new Error(`Port ${port} is occupied. Choose REHEARSAL_WORKER_PORT; no existing process was stopped.`)));
    probe.listen(port, '127.0.0.1', () => probe.close(error => error ? reject(error) : resolveResult()));
  });
}
function isTerminal(handle: WorkerHandle): boolean { return handle.record.exit !== undefined || handle.record.spawnError !== undefined; }
async function startWorker(lifetime: number): Promise<WorkerHandle> {
  await assertPortUnused();
  await mkdir(dataDir, { recursive: true, mode: 0o700 });
  const generation = report.processes.length + 1;
  const record: ProcessEvidence = {
    generation, startedAt: new Date().toISOString(), port, logFile: `${dataDirRelative}/worker-${generation}.log`,
    orderLifetimeSeconds: lifetime,
  };
  report.processes.push(record);
  const child = spawn(process.execPath, ['--import', 'tsx', 'apps/worker/src/index.ts'], {
    cwd: ROOT,
    // Only public chain config reaches the worker. No disposable wallet key or
    // broad parent environment is inherited by the merchant process.
    env: {
      PATH: process.env.PATH,
      TMPDIR: process.env.TMPDIR,
      RPC_URL: config.rpcUrl, PROGRAM_ID: config.programId, MINT: config.mint,
      MERCHANT: config.merchant, CLUSTER: cluster,
      WORKER_DATA_DIR: dataDir, WORKER_HOST: '127.0.0.1', WORKER_PORT: String(port),
      WORKER_PUBLIC_ORIGIN: baseUrl, ORDER_LIFETIME_SECONDS: String(lifetime),
      CHALLENGE_LIFETIME_SECONDS: '120', CORS_ORIGINS: 'http://localhost:5173',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  record.pid = child.pid;
  const handle: WorkerHandle = { child, record, logTail: '' };
  worker = handle;
  child.on('error', error => { record.spawnError = error.message; });
  child.on('exit', (code, signal) => { record.exit = { at: new Date().toISOString(), code, signal, observed: true }; });
  const capture = (chunk: Buffer): void => { handle.logTail = (handle.logTail + chunk.toString()).slice(-65536); };
  child.stdout?.on('data', capture);
  child.stderr?.on('data', capture);
  const end = Date.now() + 90_000;
  while (Date.now() < end) {
    assertNotInterrupted();
    if (isTerminal(handle)) throw new Error(`Owned worker terminated before health: ${JSON.stringify(record.exit ?? record.spawnError)} ${handle.logTail}`);
    try {
      const response = await http('/health', {}, 1500);
      if (response.ok && (await response.json() as { ok?: boolean }).ok === true) {
        assert(!isTerminal(handle), 'Owned worker exited during health check.');
        assert.deepEqual(await json('/api/config'), config, 'Worker config differs from the verified chain config.');
        await checkpoint(`worker-${generation}-ready`);
        return handle;
      }
      await response.arrayBuffer();
    } catch (error) {
      if (isTerminal(handle)) throw new Error(`Owned worker exited during startup: ${handle.logTail}`);
      if (!(error instanceof TypeError) && !(error instanceof DOMException)) throw error;
    }
    await delay(250);
  }
  throw new Error(`Owned worker health timed out; process was not treated as stopped. ${handle.logTail}`);
}
async function stopWorker(handle: WorkerHandle): Promise<void> {
  if (handle.stopPromise) return handle.stopPromise;
  handle.stopPromise = (async () => {
    if (!isTerminal(handle)) {
      handle.record.stopRequestedAt = new Date().toISOString();
      if (!handle.child.kill('SIGTERM')) throw new Error(`Could not signal owned worker PID ${handle.record.pid}.`);
      const deadline = Date.now() + 10_000;
      while (!isTerminal(handle) && Date.now() < deadline) await delay(100);
      if (!isTerminal(handle)) {
        handle.record.forcedKill = true;
        if (!handle.child.kill('SIGKILL')) throw new Error(`Could not terminate owned worker PID ${handle.record.pid}.`);
        const killDeadline = Date.now() + 5000;
        while (!isTerminal(handle) && Date.now() < killDeadline) await delay(100);
      }
    }
    assert(handle.record.exit || handle.record.spawnError, 'Owned process exit was not observed; API-offline proof is unavailable.');
    await writeFile(resolve(ROOT, handle.record.logFile), handle.logTail, { mode: 0o600 });
  })();
  return handle.stopPromise;
}
async function assertApiOffline(handle: WorkerHandle): Promise<{ at: string; pid: number; exit: ProcessEvidence['exit']; healthError: 'ECONNREFUSED' }> {
  assert(handle.record.pid && handle.record.exit, 'A real child PID and its exit event are required.');
  assert(handle.child.exitCode !== null || handle.child.signalCode !== null, 'Child process is still live.');
  for (let attempt = 0; attempt < 4; attempt += 1) {
    try {
      const response = await http('/health', {}, 1500);
      await response.arrayBuffer();
      throw new Error('Merchant API still answers after the owned worker exited; another listener may have appeared.');
    } catch (error) {
      if (networkErrorCode(error) === 'ECONNREFUSED') {
        return { at: new Date().toISOString(), pid: handle.record.pid, exit: handle.record.exit, healthError: 'ECONNREFUSED' };
      }
      if (attempt === 3 || error instanceof assert.AssertionError) throw error;
      await delay(200);
    }
  }
  throw new Error('Could not prove API connection refusal.');
}
async function upload(mode: 'normal' | 'stall'): Promise<Order> {
  const form = new FormData();
  form.set('buyer', buyer.publicKey.toBase58());
  form.set('mode', mode);
  form.set('file', new Blob([new Uint8Array(inputPng)], { type: 'image/png' }), 'holdfast-rehearsal.png');
  const response = await http('/api/orders', { method: 'POST', body: form });
  assert.equal(response.status, 201, await response.clone().text());
  const order = await response.json() as Order;
  assert.match(order.jobId, /^[0-9a-f]{64}$/);
  assert.equal(order.jobAddress, deriveJobAddress(config, buyer.publicKey, order.jobId).toBase58());
  assert.equal(order.buyer, buyer.publicKey.toBase58());
  assert.equal(order.merchant, config.merchant);
  assert.equal(order.mint, config.mint);
  assert.equal(order.amount, config.amount);
  assert.equal(order.mode, mode);
  assert.equal(order.status, 'quoted');
  assert.equal(order.previewUrl, undefined);
  assert.equal('originalUrl' in order || 'input' in order || 'output' in order, false);
  return order;
}
async function beginScenario(mode: 'normal' | 'stall'): Promise<ScenarioEvidence> {
  const order = await upload(mode);
  const vault = deriveVaultAddress(config, order.jobAddress);
  assert.equal(await fetchJob(connection, config, order.jobAddress), null, 'Fresh quote unexpectedly already exists on chain.');
  const scenario: ScenarioEvidence = {
    order, jobAddress: order.jobAddress, vault: vault.toBase58(), recoveryLink: `/recover?job=${order.jobAddress}`,
    before: await balances(connection, config, buyer.publicKey, vault), states: [],
    buyerNativeLamports: {
      before: await connection.getBalance(buyer.publicKey, 'finalized'),
      note: 'Lamports are recorded separately from SPL token units. Native changes include account rent plus fees; token deltas exclude both.',
    },
  };
  if (mode === 'normal') report.release = scenario;
  else report.refund = scenario;
  assert.equal(scenario.before.vault, '0');
  scenario.fundingAttempted = true;
  // Record address/deadline before broadcast so a timeout never hides a deposit.
  await checkpoint(`${mode}-funding-submitting`);
  const fundSignature = await send(connection, await buildFundTransaction(connection, config, {
    buyer: buyer.publicKey, jobId: order.jobId, expiresAt: order.expiresAt,
  }), [buyer]);
  scenario.fund = txEvidence(config, fundSignature);
  await checkpoint(`${mode}-fund-submitted`);
  scenario.afterFund = await balances(connection, config, buyer.publicKey, vault);
  scenario.buyerNativeLamports.afterFund = await connection.getBalance(buyer.publicKey, 'finalized');
  const funded = await requireJob(connection, config, order.jobAddress);
  assert.equal(funded.state, 'Funded');
  assert.equal(funded.buyer, order.buyer);
  assert.equal(funded.merchant, order.merchant);
  assert.equal(funded.mint, order.mint);
  assert.equal(funded.amount, order.amount);
  assert.equal(funded.expiresAt, order.expiresAt);
  scenario.states.push({ at: new Date().toISOString(), state: funded.state });
  assert.equal(BigInt(scenario.before.buyer) - BigInt(scenario.afterFund.buyer), BigInt(config.amount));
  assert.equal(scenario.afterFund.merchant, scenario.before.merchant);
  assert.equal(scenario.afterFund.vault, config.amount);
  await checkpoint(`${mode}-funded`);
  console.log(`${mode}: funded ${order.jobAddress} ${fundSignature}`);
  const acknowledged = await json<Order>(`/api/orders/${order.jobId}/funded`, { signature: fundSignature });
  assert.equal(acknowledged.jobAddress, order.jobAddress);
  if (mode === 'stall') assert.equal(acknowledged.status, 'funded');
  return scenario;
}
async function waitReady(order: Order): Promise<Order> {
  const deadline = Date.now() + 120_000;
  let last: Order | undefined;
  while (Date.now() < deadline) {
    assertNotInterrupted();
    last = await json<Order>(`/api/orders/${order.jobId}`);
    if (last.status === 'ready') return last;
    if (last.status === 'refunded' || last.status === 'released') throw new Error(`Unexpected terminal job while awaiting preview: ${last.status}`);
    await delay(500);
  }
  throw new Error(`PNG conversion did not become ready: ${JSON.stringify(last)}`);
}
async function transactionFee(signature: string): Promise<number> {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    const transaction = await connection.getTransaction(signature, { commitment: 'finalized', maxSupportedTransactionVersion: 0 });
    if (transaction?.meta) {
      assert.equal(transaction.meta.err, null, 'Recorded transaction failed.');
      return transaction.meta.fee;
    }
    await delay(500);
  }
  throw new Error(`Finalized transaction metadata unavailable for ${signature}; fee evidence is incomplete.`);
}
async function recordSettlement(scenario: ScenarioEvidence, signature: string, expected: 'Released' | 'Refunded'): Promise<void> {
  scenario.settle = txEvidence(config, signature);
  await checkpoint(`${scenario.order.mode}-settlement-submitted`);
  const job = await requireJob(connection, config, scenario.jobAddress);
  assert.equal(job.state, expected);
  scenario.states.push({ at: new Date().toISOString(), state: job.state });
  scenario.after = await balances(connection, config, buyer.publicKey, new PublicKey(scenario.vault));
  assert.equal(scenario.after.vault, '0');
  assert.ok(scenario.afterFund && scenario.fund);
  if (expected === 'Released') {
    assert.equal(scenario.after.buyer, scenario.afterFund.buyer);
    assert.equal(BigInt(scenario.after.merchant) - BigInt(scenario.afterFund.merchant), BigInt(config.amount));
  } else {
    assert.equal(scenario.after.buyer, scenario.before.buyer);
    assert.equal(scenario.after.merchant, scenario.before.merchant);
    assert.equal(BigInt(scenario.after.buyer) - BigInt(scenario.afterFund.buyer), BigInt(config.amount));
  }
  const [fundFee, settlementFee, nativeAfter] = await Promise.all([
    transactionFee(scenario.fund.signature), transactionFee(signature), connection.getBalance(buyer.publicKey, 'finalized'),
  ]);
  scenario.feesLamports = { fund: fundFee, settlement: settlementFee };
  scenario.buyerNativeLamports.afterSettlement = nativeAfter;
  scenario.buyerNativeLamports.rentAndOtherCostsExcludingFees = scenario.buyerNativeLamports.before - nativeAfter - fundFee - settlementFee;
  await checkpoint(`${scenario.order.mode}-${expected.toLowerCase()}`);
  console.log(`${scenario.order.mode}: ${expected} ${signature}`);
}
async function download(order: Order, challenge: Challenge): Promise<Buffer> {
  const response = await http(`/api/orders/${order.jobId}/download`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ buyer: buyer.publicKey.toBase58(), nonce: challenge.nonce, signature: signedMessage(buyer, challenge.message) }),
  });
  assert.equal(response.status, 200, await response.clone().text());
  assert.equal(response.headers.get('cache-control'), 'no-store');
  assert.match(response.headers.get('content-type') ?? '', /^image\/webp/);
  assert.match(response.headers.get('content-disposition') ?? '', /attachment.*\.webp/);
  return Buffer.from(await response.arrayBuffer());
}
async function runRelease(): Promise<void> {
  const scenario = await beginScenario('normal');
  const ready = await waitReady(scenario.order);
  const path = `/api/orders/${ready.jobId}`;
  assert.ok(ready.previewUrl);
  await checkpoint('release-pre-approval-storage');
  const orderDirectory = resolve(dataDir, 'orders', ready.jobId);
  const [storedJson, original, persistedPreview, input, fileStat] = await Promise.all([
    readFile(resolve(orderDirectory, 'order.json'), 'utf8'), readFile(resolve(orderDirectory, 'result.webp')),
    readFile(resolve(orderDirectory, 'preview.webp')), readFile(resolve(orderDirectory, 'input.png')),
    stat(resolve(orderDirectory, 'result.webp')),
  ]);
  const stored = JSON.parse(storedJson) as StoredOrder;
  assert.ok(stored.output && stored.preview);
  assert.equal(stored.jobAddress, ready.jobAddress);
  assert.equal(stored.status, 'ready');
  assert.equal(stored.input.sha256, hash(inputPng));
  assert.equal(hash(input), hash(inputPng));
  assert.equal(stored.output.sha256, hash(original));
  assert.equal(stored.output.size, original.length);
  assert.equal(stored.preview.sha256, hash(persistedPreview));
  const originalMetadata = await sharp(original).metadata();
  assert.equal(originalMetadata.format, 'webp');
  const previewResponse = await http(ready.previewUrl);
  assert.equal(previewResponse.status, 200);
  const preview = Buffer.from(await previewResponse.arrayBuffer());
  assert.equal(hash(preview), hash(persistedPreview));
  assert.notEqual(hash(preview), hash(original), 'Preview must not be the private original.');
  const previewMetadata = await sharp(preview).metadata();
  assert.equal(previewMetadata.format, 'webp');
  assert.ok(previewMetadata.width && previewMetadata.height);
  assert(previewMetadata.height > (originalMetadata.height ?? 0), 'Preview is missing its visible watermark caption band.');
  const captionPixel = await sharp(preview).extract({ left: 0, top: previewMetadata.height - 1, width: 1, height: 1 }).removeAlpha().raw().toBuffer();
  assert(captionPixel[0] < 60 && captionPixel[1] < 70 && captionPixel[2] < 80, 'Visible dark watermark caption missing.');
  assert.equal((await requireJob(connection, config, ready.jobAddress)).state, 'Funded');
  scenario.preApprovalStorage = {
    checkedAt: new Date().toISOString(), state: 'Funded', resultPersistedBeforeApproval: true,
    inputSha256: hash(inputPng), resultSha256: hash(original), resultBytes: original.length,
    resultFileMtime: fileStat.mtime.toISOString(), resultMatchesDurableManifest: true,
    previewSha256: hash(preview), previewBytes: preview.length, previewWidth: previewMetadata.width,
    previewHeight: previewMetadata.height, previewDiffersFromOriginal: true,
    watermarkCaptionPixelRgb: [...captionPixel],
  };
  const preReleaseChallenge = await rejectHttp(`${path}/challenge`, { buyer: buyer.publicKey.toBase58() }, 403);
  const preReleaseDownload = await rejectHttp(`${path}/download`, {
    buyer: buyer.publicKey.toBase58(), nonce: '0'.repeat(64), signature: signedMessage(buyer, 'not an authorization'),
  }, 403);
  scenario.privateAccess = { preReleaseChallenge, preReleaseDownload };
  scenario.settlementAttempted = true;
  await checkpoint('release-approval-submitting');
  const approved = await send(connection, await buildApproveTransaction(connection, config, {
    buyer: buyer.publicKey, jobAddress: ready.jobAddress,
  }), [buyer]);
  await recordSettlement(scenario, approved, 'Released');
  const wrongBuyerChallenge = await rejectHttp(`${path}/challenge`, { buyer: secondWallet.publicKey.toBase58() }, 403);
  const challenge = await json<Challenge>(`${path}/challenge`, { buyer: buyer.publicKey.toBase58() });
  for (const field of [ready.jobId, ready.jobAddress, buyer.publicKey.toBase58(), 'Purpose: download', `Domain: ${baseUrl}`]) {
    assert(challenge.message.includes(field), `Signed challenge is missing ${field}.`);
  }
  const wrongWalletSignature = await rejectHttp(`${path}/download`, {
    buyer: buyer.publicKey.toBase58(), nonce: challenge.nonce, signature: signedMessage(secondWallet, challenge.message),
  }, 401);
  const wrongBuyerDownload = await rejectHttp(`${path}/download`, {
    buyer: secondWallet.publicKey.toBase58(), nonce: challenge.nonce, signature: signedMessage(secondWallet, challenge.message),
  }, 403);
  const unlocked = await download(ready, challenge);
  assert.equal(hash(unlocked), hash(original));
  const replayDenied = await rejectHttp(`${path}/download`, {
    buyer: buyer.publicKey.toBase58(), nonce: challenge.nonce, signature: signedMessage(buyer, challenge.message),
  }, 401);
  scenario.privateAccess = { ...scenario.privateAccess, wrongBuyerChallenge, wrongWalletSignature, wrongBuyerDownload, originalBuyerDownload: 200, replayDenied, resultSha256: hash(unlocked) };
  await checkpoint('release-download-verified');
  assert(worker);
  const first = worker;
  await stopWorker(first);
  const stopped = await assertApiOffline(first);
  await checkpoint('release-worker-stopped');
  // Restart the exact storage directory. New quotes now use the shorter refund
  // deadline; existing quotes keep their original immutable deadline.
  const restarted = await startWorker(refundLifetime);
  assert.notEqual(restarted.record.pid, first.record.pid);
  const recovered = await json<Order>(path);
  assert.equal(recovered.status, 'released');
  assert.equal(recovered.jobAddress, ready.jobAddress);
  const listed = await json<{ orders: Order[] }>(`/api/orders?buyer=${buyer.publicKey.toBase58()}`);
  assert(listed.orders.some(order => order.jobId === ready.jobId && order.status === 'released'));
  const consumedAfterRestart = await rejectHttp(`${path}/download`, {
    buyer: buyer.publicKey.toBase58(), nonce: challenge.nonce, signature: signedMessage(buyer, challenge.message),
  }, 401);
  const freshChallenge = await json<Challenge>(`${path}/challenge`, { buyer: buyer.publicKey.toBase58() });
  assert.notEqual(freshChallenge.nonce, challenge.nonce);
  const downloadedAgain = await download(recovered, freshChallenge);
  assert.equal(hash(downloadedAgain), hash(original));
  scenario.restartRecovery = {
    firstPid: first.record.pid, restartedPid: restarted.record.pid, stopped,
    sameDataDir: dataDirRelative, chainState: 'Released', workerStatus: recovered.status,
    consumedChallengeRejectedAfterRestart: consumedAfterRestart, freshChallengeDownload: 200,
    resultSha256: hash(downloadedAgain), identicalBytes: original.equals(downloadedAgain),
  };
  await checkpoint('release-restart-recovery-verified');
}
async function runOfflineRefund(): Promise<void> {
  const scenario = await beginScenario('stall');
  const order = await json<Order>(`/api/orders/${scenario.order.jobId}`);
  assert.equal(order.mode, 'stall');
  assert.equal(order.status, 'funded');
  assert.equal(order.previewUrl, undefined);
  const stored = JSON.parse(await readFile(resolve(dataDir, 'orders', order.jobId, 'order.json'), 'utf8')) as StoredOrder;
  assert.equal(stored.output, undefined, 'Stalled order unexpectedly has a private result.');
  assert.equal(stored.preview, undefined);
  assert.equal((await requireJob(connection, config, order.jobAddress)).state, 'Funded');
  assert(worker);
  const stoppedWorker = worker;
  await checkpoint('refund-stopping-merchant-api');
  await stopWorker(stoppedWorker);
  const beforeDeadline = await assertApiOffline(stoppedWorker);
  scenario.apiOffline = { beforeDeadline, deterministicStall: true, noPersistedResult: true, refundClient: '@holdfast/chain buildRefundTransaction + direct RPC', usesMerchantApi: false };
  await checkpoint('refund-api-offline-awaiting-chain-expiry');
  console.log(`stall: merchant PID ${stoppedWorker.record.pid} exited; API connection refused. Waiting for chain deadline ${order.expiresAt}.`);
  await waitUntilChain(connection, order.expiresAt, (refundLifetime + 180) * 1000);
  assertNotInterrupted();
  const atDeadline = await assertApiOffline(stoppedWorker);
  assert.equal((await requireJob(connection, config, order.jobAddress)).state, 'Funded');
  const beforeRefund = await balances(connection, config, buyer.publicKey, new PublicKey(scenario.vault));
  assert.deepEqual(beforeRefund, scenario.afterFund, 'Token balances changed while the API was stopped.');
  scenario.apiOffline = { ...scenario.apiOffline, atDeadline, beforeRefund, observedFundedAtDeadline: true };
  scenario.settlementAttempted = true;
  await checkpoint('refund-direct-transaction-submitting');
  const httpRequestsBeforeRefund = report.http.length;
  // No merchant endpoint is called to read the job or build/sign/submit refund.
  const refunded = await send(connection, await buildRefundTransaction(connection, config, {
    buyer: buyer.publicKey, jobAddress: order.jobAddress,
  }), [buyer]);
  await recordSettlement(scenario, refunded, 'Refunded');
  assert.equal(report.http.length, httpRequestsBeforeRefund, 'Refund unexpectedly accessed the merchant HTTP API.');
  const afterRefund = await assertApiOffline(stoppedWorker);
  scenario.apiOffline = { ...scenario.apiOffline, afterRefund, merchantHttpRequestsDuringRefund: 0, finalizedState: 'Refunded' };
  await checkpoint('refund-offline-recovery-verified');
}
async function captureFailure(error: unknown): Promise<void> {
  report.passed = false;
  report.error = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
  for (const scenario of [report.release, report.refund]) {
    if (!scenario) continue;
    try { scenario.observedAtFailure = await fetchJob(connection, config, scenario.jobAddress); }
    catch (readError) { scenario.observedAtFailure = String(readError); }
  }
  report.updatedAt = new Date().toISOString();
  await writeEvidence(`rehearsal-${cluster}-progress`, report);
  await writeEvidence(`rehearsal-${cluster}-${runId}-progress`, report);
}

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.once(signal, () => {
    interrupted = true;
    void (async () => {
      try {
        if (worker) await stopWorker(worker);
        await captureFailure(new Error(`Interrupted by ${signal}. Funded job addresses and deadlines are preserved.`));
      } finally { process.exit(signal === 'SIGINT' ? 130 : 143); }
    })();
  });
}

try {
  report.genesis = await assertNetwork(connection, config);
  const program = await connection.getAccountInfo(new PublicKey(config.programId), 'finalized');
  assert(program?.executable, 'Deploy the program before the product rehearsal.');
  const initial = await balances(connection, config, buyer.publicKey, deriveVaultAddress(config, deriveJobAddress(config, buyer.publicKey, randomBytes(32).toString('hex'))));
  assert(BigInt(initial.buyer) >= BigInt(config.amount) * 2n, 'Disposable buyer needs at least 10 mock USDC. Rerun the deploy script to top up.');
  assert(await connection.getBalance(buyer.publicKey, 'finalized') >= 30_000_000, 'Disposable buyer needs at least 0.03 test SOL for fees and account rent. Rerun deploy to top up.');
  inputPng = await sharp(Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="640" height="400">
    <defs><linearGradient id="bg"><stop stop-color="#19c4c0"/><stop offset="1" stop-color="#e9f5ce"/></linearGradient></defs>
    <rect width="640" height="400" fill="url(#bg)"/>
    <circle cx="530" cy="90" r="120" fill="#ff7646"/>
    <path d="M0 330 L260 120 L450 400 H0Z" fill="#15382f"/>
    <text x="34" y="70" font-family="sans-serif" font-size="32" font-weight="bold" fill="#15382f">PAY FOR THE RESULT</text>
    <text x="34" y="110" font-family="sans-serif" font-size="20" fill="#15382f">Holdfast PNG → WebP rehearsal</text>
  </svg>`)).png().toBuffer();
  await checkpoint('network-and-funding-preflight-passed');
  await startWorker(releaseLifetime);
  await runRelease();
  await runOfflineRefund();
  assert(report.processes.every(item => item.exit?.observed), 'Every owned worker must have an observed terminal exit.');
  report.passed = true;
  report.finishedAt = new Date().toISOString();
  await checkpoint('passed');
  await writeEvidence(`rehearsal-${cluster}`, report);
  await writeEvidence(`rehearsal-${cluster}-${runId}`, report);
  console.log(`Rehearsal passed: evidence/rehearsal-${cluster}.json`);
} catch (error) {
  await captureFailure(error);
  throw error;
} finally {
  if (worker) await stopWorker(worker);
  report.updatedAt = new Date().toISOString();
  await writeEvidence(`rehearsal-${cluster}-progress`, report);
  await writeEvidence(`rehearsal-${cluster}-${runId}-progress`, report);
  if (!report.passed) {
    await writeEvidence(`rehearsal-${cluster}`, report);
    await writeEvidence(`rehearsal-${cluster}-${runId}`, report);
  }
}
