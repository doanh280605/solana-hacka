import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { createHash, createPrivateKey, randomBytes, sign } from 'node:crypto';
import { access, mkdir, readFile, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { relative, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import type { Browser, BrowserContext, Page, Video } from 'playwright-core';
import { PublicKey, Transaction, deriveVaultAddress, getConnection, type Job, type Order } from '@holdfast/chain';
import sharp from 'sharp';
import { ROOT, assertNetwork, balances, clusterArg, loadConfig, loadKey, requireJob, txEvidence, waitUntilChain, writeEvidence } from './common.js';

// Test harness only. The product never imports this file or contains a signing key.
// Only a public key and signature callbacks cross into the isolated browser.
const cluster = clusterArg();
const smokeOnly = process.argv.includes('--smoke');
const captureJob = process.argv.find((argument) => argument.startsWith('--capture-job='))?.slice('--capture-job='.length);
const evidenceName = `${smokeOnly ? 'ui-smoke' : 'ui'}-${cluster}`;
process.env.PLAYWRIGHT_BROWSERS_PATH ||= resolve(ROOT, '.local/playwright');
const { chromium } = await import('playwright-core');
const config = await loadConfig(cluster);
const connection = getConnection(config);
const buyer = await loadKey('buyer');
const runId = `${new Date().toISOString().replace(/[^0-9]/g, '')}-${randomBytes(3).toString('hex')}`;
const runDir = resolve(ROOT, `.local/ui-${cluster}-${runId}`);
const screenshotsDir = resolve(ROOT, 'evidence/screenshots');
const videoDir = resolve(runDir, 'videos');
const workerPort = integer('UI_WORKER_PORT', 18788);
const webPort = integer('UI_WEB_PORT', 15173);
const workerOrigin = `http://127.0.0.1:${workerPort}`;
const webOrigin = `http://127.0.0.1:${webPort}`;
const dataDir = resolve(runDir, 'worker');
const pageErrors: string[] = [];
const merchantRequestsOnRecovery: string[] = [];
const signedTransactions: { at: string; programs: string[] }[] = [];
const processes: ProcessRecord[] = [];
const artifacts: { screenshots: string[]; videos: string[] } = { screenshots: [], videos: [] };
const report: Record<string, unknown> = {
  schemaVersion: 1, runId, startedAt: new Date().toISOString(), cluster,
  rpcUrl: config.rpcUrl, programId: config.programId, mint: config.mint, merchant: config.merchant,
  buyer: buyer.publicKey.toBase58(), amount: config.amount, decimals: 6,
  token: 'Mock USDC, test tokens only',
  scope: 'Real browser UI and real chain transactions. A disposable wallet provider is injected only by this Node harness; this does not verify the Phantom browser extension.',
  privateKeysInBrowser: false, workerDataDir: relative(ROOT, dataDir),
  workerOrigin, webOrigin, processes, artifacts, signedTransactions, pageErrors,
  merchantRequestsOnRecovery, passed: false, stage: 'preflight',
};
interface ProcessRecord {
  name: string; pid?: number; startedAt: string; stopRequestedAt?: string;
  exit?: { at: string; code: number | null; signal: NodeJS.Signals | null };
  spawnError?: string; forcedKill?: boolean; logFile: string;
}
interface OwnedProcess { child: ChildProcess; record: ProcessRecord; log: string; }
type Scenario = {
  order: Order; vault: string; before: Awaited<ReturnType<typeof balances>>;
  afterFund?: Awaited<ReturnType<typeof balances>>; after?: Awaited<ReturnType<typeof balances>>;
  fund?: ReturnType<typeof txEvidence>; settlement?: ReturnType<typeof txEvidence>;
  fundedJob?: Job; settledJob?: Job;
  [key: string]: unknown;
};
let worker: OwnedProcess | undefined;
let web: OwnedProcess | undefined;
let browser: Browser | undefined;
let context: BrowserContext | undefined;
let interrupted = false;
const videoPages: { page: Page; video: Video | null; name: string }[] = [];

function integer(name: string, fallback: number): number {
  const value = Number(process.env[name] ?? fallback);
  assert(Number.isInteger(value) && value >= 1024 && value <= 65535, `${name} must be a valid nonprivileged port.`);
  return value;
}
function hash(bytes: Uint8Array): string { return createHash('sha256').update(bytes).digest('hex'); }
function terminal(handle: OwnedProcess): boolean { return !!handle.record.exit || !!handle.record.spawnError; }
async function checkpoint(stage: string) {
  report.stage = stage; report.updatedAt = new Date().toISOString();
  await writeEvidence(`${evidenceName}-progress`, report);
  await writeEvidence(`${evidenceName}-${runId}-progress`, report);
  console.log(`UI ${cluster}: ${stage}`);
  if (interrupted) throw new Error('UI rehearsal interrupted. Recovery job addresses remain in progress evidence.');
}
async function until(label: string, check: () => Promise<boolean>, timeoutMs = 120_000) {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    if (interrupted) throw new Error('UI rehearsal interrupted.');
    if (await check()) return;
    await delay(350);
  }
  throw new Error(`Timed out: ${label}.`);
}
async function portUnused(port: number) {
  await new Promise<void>((accept, reject) => {
    const probe = createServer();
    probe.once('error', () => reject(new Error(`Port ${port} is occupied. Set UI_WORKER_PORT/UI_WEB_PORT. Existing processes are never stopped.`)));
    probe.listen(port, '127.0.0.1', () => probe.close((error) => error ? reject(error) : accept()));
  });
}
function start(name: string, args: string[], cwd: string, env: NodeJS.ProcessEnv): OwnedProcess {
  const record: ProcessRecord = { name, startedAt: new Date().toISOString(), logFile: relative(ROOT, resolve(runDir, `${name}.log`)) };
  const child = spawn(process.execPath, args, { cwd, env, stdio: ['ignore', 'pipe', 'pipe'] });
  const handle = { child, record, log: '' };
  record.pid = child.pid; processes.push(record);
  child.once('error', (error) => { record.spawnError = error.message; });
  child.once('exit', (code, signal) => { record.exit = { at: new Date().toISOString(), code, signal }; });
  const capture = (chunk: Buffer) => { handle.log = (handle.log + chunk.toString()).slice(-100_000); };
  child.stdout?.on('data', capture); child.stderr?.on('data', capture);
  return handle;
}
async function stop(handle?: OwnedProcess) {
  if (!handle) return;
  if (!terminal(handle)) {
    handle.record.stopRequestedAt = new Date().toISOString();
    assert(handle.child.kill('SIGTERM'), `Could not signal owned ${handle.record.name}.`);
    try { await until(`owned ${handle.record.name} exits`, async () => terminal(handle), 10_000); }
    catch {
      handle.record.forcedKill = true; handle.child.kill('SIGKILL');
      await until(`owned ${handle.record.name} is terminal`, async () => terminal(handle), 5000);
    }
  }
  assert(handle.record.exit || handle.record.spawnError, 'No authoritative child termination observed.');
  await writeFile(resolve(ROOT, handle.record.logFile), handle.log, { mode: 0o600 });
}
async function health(handle: OwnedProcess, url: string) {
  await until(`${handle.record.name} health`, async () => {
    if (terminal(handle)) throw new Error(`${handle.record.name} terminated: ${handle.log}`);
    try { const response = await fetch(url, { signal: AbortSignal.timeout(1500) }); await response.arrayBuffer(); return response.ok; }
    catch { return false; }
  }, 60_000);
}
async function startWorker(lifetime: number) {
  await portUnused(workerPort);
  worker = start(`worker-${processes.filter((item) => item.name.startsWith('worker')).length + 1}`, ['--import', 'tsx', 'apps/worker/src/index.ts'], ROOT, {
    PATH: process.env.PATH, TMPDIR: process.env.TMPDIR,
    RPC_URL: config.rpcUrl, PROGRAM_ID: config.programId, MINT: config.mint, MERCHANT: config.merchant, CLUSTER: cluster,
    WORKER_DATA_DIR: dataDir, WORKER_HOST: '127.0.0.1', WORKER_PORT: String(workerPort), WORKER_PUBLIC_ORIGIN: workerOrigin,
    ORDER_LIFETIME_SECONDS: String(lifetime), CHALLENGE_LIFETIME_SECONDS: '120', CORS_ORIGINS: webOrigin,
  });
  await health(worker, `${workerOrigin}/health`);
  const served = await fetch(`${workerOrigin}/api/config`).then((response) => response.json());
  assert.deepEqual(served, config);
  return worker;
}
function errorCode(error: unknown): string {
  if (error && typeof error === 'object') {
    if ('code' in error && typeof error.code === 'string') return error.code;
    if ('cause' in error) return errorCode(error.cause);
  }
  return String(error);
}
async function apiOffline(handle: OwnedProcess) {
  assert(handle.record.exit, 'An observed worker exit event is required.');
  assert(handle.child.exitCode !== null || handle.child.signalCode !== null, 'Worker is still live.');
  try { const response = await fetch(`${workerOrigin}/health`, { signal: AbortSignal.timeout(1500) }); await response.arrayBuffer(); throw new Error('API still responds.'); }
  catch (error) { assert.equal(errorCode(error), 'ECONNREFUSED', 'The API must refuse the connection, not merely time out.'); }
  return { at: new Date().toISOString(), pid: handle.record.pid, exit: handle.record.exit, health: 'ECONNREFUSED' };
}
async function screenshot(page: Page, name: string) {
  const path = resolve(screenshotsDir, `${evidenceName}-${name}.png`);
  await page.evaluate('new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))');
  await page.screenshot({ path, fullPage: true, animations: 'disabled' });
  artifacts.screenshots.push(relative(ROOT, path));
}
async function assertResponsive(page: Page) {
  const size = await page.evaluate(() => ({ viewport: window.innerWidth, content: document.documentElement.scrollWidth }));
  assert(size.content <= size.viewport, `Horizontal overflow: ${JSON.stringify(size)}`);
}
async function newPage(name: string, recovery = false) {
  assert(context);
  const page = await context.newPage();
  page.setDefaultTimeout(120_000);
  page.on('pageerror', (error) => pageErrors.push(`${name}: ${error.message}`));
  if (recovery) page.on('request', (request) => { if (new URL(request.url()).origin === workerOrigin) merchantRequestsOnRecovery.push(request.url()); });
  videoPages.push({ page, name, video: page.video() });
  return page;
}
async function addHarnessWallet(context: BrowserContext) {
  const privateKey = createPrivateKey({
    key: Buffer.concat([Buffer.from('302e020100300506032b657004220420', 'hex'), Buffer.from(buyer.secretKey.subarray(0, 32))]),
    type: 'pkcs8', format: 'der',
  });
  await context.exposeFunction('__holdfastTestSignTransaction', async (serialized: string) => {
    const transaction = Transaction.from(Buffer.from(serialized, 'base64'));
    assert(transaction.feePayer?.equals(buyer.publicKey), 'Harness only signs for the disposable buyer.');
    const allowed = new Set([config.programId, '11111111111111111111111111111111', 'ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL', 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA']);
    assert(transaction.instructions.some((instruction) => instruction.programId.toBase58() === config.programId), 'Harness signs only Holdfast checkout transactions.');
    for (const instruction of transaction.instructions) {
      assert(allowed.has(instruction.programId.toBase58()), 'Unexpected transaction program.');
      for (const key of instruction.keys) if (key.isSigner) assert(key.pubkey.equals(buyer.publicKey), 'Unexpected required signer.');
    }
    transaction.partialSign(buyer);
    const signature = transaction.signatures.find((item) => item.publicKey.equals(buyer.publicKey))?.signature;
    assert(signature?.length === 64);
    signedTransactions.push({ at: new Date().toISOString(), programs: transaction.instructions.map((item) => item.programId.toBase58()) });
    return [...signature];
  });
  await context.exposeFunction('__holdfastTestSignMessage', async (bytes: number[]) => {
    const message = Buffer.from(bytes).toString('utf8');
    assert(message.includes('Purpose: download') && message.includes(`Domain: ${workerOrigin}`) && message.includes(buyer.publicKey.toBase58()), 'Harness signs only this merchant download challenge.');
    return [...sign(null, Buffer.from(bytes), privateKey)];
  });
  // Use literal browser source: tsx's function-name helper must not leak into
  // a serialized Playwright init callback.
  await context.addInitScript(`(() => {
    const publicKey = ${JSON.stringify(buyer.publicKey.toBase58())};
    const origin = ${JSON.stringify(webOrigin)};
    if (window.location.origin !== origin) return;
    const scope = window;
    const key = { toString: () => publicKey };
    const trusted = () => localStorage.getItem('holdfast.harness.trusted') === 'yes';
    const listeners = new Map();
    const provider = {
      publicKey: trusted() ? key : null,
      async connect(options) {
        if (options?.onlyIfTrusted && !trusted()) throw new Error('Test wallet awaits explicit connection.');
        localStorage.setItem('holdfast.harness.trusted', 'yes'); provider.publicKey = key;
        return { publicKey: key };
      },
      async disconnect() { provider.publicKey = null; localStorage.removeItem('holdfast.harness.trusted'); listeners.get('disconnect')?.forEach((listener) => listener()); },
      on(event, listener) { if (!listeners.has(event)) listeners.set(event, new Set()); listeners.get(event).add(listener); },
      removeListener(event, listener) { listeners.get(event)?.delete(listener); },
      async signTransaction(transaction) {
        const raw = transaction.serialize({ requireAllSignatures: false, verifySignatures: false });
        const encoded = btoa(Array.from(raw, (value) => String.fromCharCode(value)).join(''));
        const signature = await scope.__holdfastTestSignTransaction(encoded);
        transaction.addSignature(transaction.feePayer, Uint8Array.from(signature));
        return transaction;
      },
      async signMessage(bytes) { return { signature: Uint8Array.from(await scope.__holdfastTestSignMessage([...bytes])) }; },
    };
    scope.solana = provider; scope.phantom = { solana: provider };
  })()`);
}
async function quote(page: Page, mode: 'normal' | 'stall', pngPath: string): Promise<Scenario> {
  await page.locator('#png-file').setInputFiles(pngPath);
  await page.getByRole('radio', { name: mode === 'normal' ? /Normal delivery/ : /Stall rehearsal/ }).check();
  const responsePromise = page.waitForResponse((response) => response.url() === `${workerOrigin}/api/orders` && response.request().method() === 'POST');
  await page.getByRole('button', { name: 'Save PNG & get a quote', exact: false }).click();
  const response = await responsePromise;
  assert.equal(response.status(), 201);
  const order = await response.json() as Order;
  assert.equal(order.buyer, buyer.publicKey.toBase58()); assert.equal(order.mode, mode); assert.equal(order.amount, config.amount);
  const vault = deriveVaultAddress(config, order.jobAddress);
  const scenario: Scenario = { order, vault: vault.toBase58(), before: await balances(connection, config, buyer.publicKey, vault) };
  report[mode === 'normal' ? 'release' : 'refund'] = scenario;
  await checkpoint(`${mode}-quoted-before-signature`);
  return scenario;
}
async function transactionLink(page: Page, action: string) {
  const href = await page.locator('.transaction-list a').filter({ hasText: action }).getAttribute('href');
  assert(href);
  const signature = new URL(href).pathname.split('/').at(-1)!;
  assert(signature.length >= 80);
  return txEvidence(config, signature);
}
async function funded(page: Page, scenario: Scenario) {
  const deposit = page.getByRole('button', { name: 'Deposit 5 test USDC', exact: false });
  await until('deposit button enabled', () => deposit.isEnabled());
  await deposit.click();
  await until('finalized job Funded', async () => { try { return (await requireJob(connection, config, scenario.order.jobAddress)).state === 'Funded'; } catch { return false; } });
  scenario.fundedJob = await requireJob(connection, config, scenario.order.jobAddress);
  scenario.afterFund = await balances(connection, config, buyer.publicKey, new PublicKey(scenario.vault));
  scenario.fund = await transactionLink(page, 'Deposit 5 test USDC');
  assert.equal(BigInt(scenario.before.buyer) - BigInt(scenario.afterFund.buyer), BigInt(config.amount));
  assert.equal(scenario.afterFund.merchant, scenario.before.merchant); assert.equal(scenario.afterFund.vault, config.amount);
  await checkpoint(`${scenario.order.mode}-funded-via-browser`);
}
async function downloaded(page: Page, index: number) {
  const downloadPromise = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Sign & download original WebP', exact: false }).click();
  const download = await downloadPromise;
  const path = resolve(runDir, `download-${index}.webp`); await download.saveAs(path);
  const bytes = await readFile(path);
  assert.equal((await sharp(bytes).metadata()).format, 'webp');
  return { bytes: bytes.length, sha256: hash(bytes), savedLocally: relative(ROOT, path) };
}
async function recordFinalBalances(scenario: Scenario, state: 'Released' | 'Refunded') {
  scenario.settledJob = await requireJob(connection, config, scenario.order.jobAddress);
  assert.equal(scenario.settledJob.state, state);
  scenario.after = await balances(connection, config, buyer.publicKey, new PublicKey(scenario.vault));
  assert.equal(scenario.after.vault, '0'); assert(scenario.afterFund);
  if (state === 'Released') {
    assert.equal(scenario.after.buyer, scenario.afterFund.buyer);
    assert.equal(BigInt(scenario.after.merchant) - BigInt(scenario.afterFund.merchant), BigInt(config.amount));
  } else {
    assert.equal(scenario.after.buyer, scenario.before.buyer);
    assert.equal(scenario.after.merchant, scenario.before.merchant);
  }
}
async function videos() {
  for (const record of videoPages) {
    if (!record.page.isClosed()) await record.page.close();
    if (!record.video) continue;
    const target = resolve(ROOT, `evidence/${evidenceName}-${record.name}.webm`);
    await record.video.saveAs(target); artifacts.videos.push(relative(ROOT, target));
  }
}

for (const signal of ['SIGINT', 'SIGTERM'] as const) process.once(signal, () => {
  interrupted = true;
  void Promise.allSettled([stop(worker), stop(web), browser?.close()]).finally(async () => {
    report.error = `Interrupted by ${signal}; inspect funded jobs in this evidence.`;
    await writeEvidence(`${evidenceName}-progress`, report); process.exit(signal === 'SIGINT' ? 130 : 143);
  });
});

try {
  await mkdir(runDir, { recursive: true, mode: 0o700 });
  await mkdir(screenshotsDir, { recursive: true }); await mkdir(videoDir, { recursive: true });
  report.genesis = await assertNetwork(connection, config);
  assert((await connection.getAccountInfo(new PublicKey(config.programId), 'finalized'))?.executable, 'Deploy the program before running the browser rehearsal.');
  await portUnused(webPort);
  await startWorker(180);
  web = start('vite', [resolve(ROOT, 'node_modules/vite/bin/vite.js'), '--host', '127.0.0.1', '--port', String(webPort), '--strictPort'], resolve(ROOT, 'apps/web'), {
    PATH: process.env.PATH, TMPDIR: process.env.TMPDIR,
    VITE_RPC_URL: config.rpcUrl, VITE_PROGRAM_ID: config.programId, VITE_MINT: config.mint,
    VITE_MERCHANT: config.merchant, VITE_CLUSTER: cluster, VITE_WORKER_URL: workerOrigin,
  });
  await health(web, webOrigin);
  browser = await chromium.launch({ headless: true, executablePath: process.env.UI_CHROME_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' });
  let videoReady = true;
  try { await access(resolve(process.env.PLAYWRIGHT_BROWSERS_PATH!, 'ffmpeg-1011/ffmpeg-mac')); }
  catch {
    videoReady = false;
    report.videoLimitation = 'Playwright ffmpeg is missing. Install with PLAYWRIGHT_BROWSERS_PATH=.local/playwright node node_modules/playwright-core/cli.js install ffmpeg. Core browser checks continue with screenshots.';
  }
  try {
    context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, acceptDownloads: true, ...(videoReady ? { recordVideo: { dir: videoDir, size: { width: 1440, height: 1000 } } } : {}) });
  } catch (error) {
    report.videoLimitation = error instanceof Error ? error.message : String(error);
    context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, acceptDownloads: true });
  }
  await addHarnessWallet(context);
  const pngPath = resolve(runDir, 'input.png');
  await sharp(Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="640" height="400"><rect width="640" height="400" fill="#e7c99a"/><path d="M0 400L315 65L540 400" fill="#282d25"/><circle cx="520" cy="90" r="65" fill="#c7431f"/><text x="30" y="55" font-size="25" font-family="sans-serif" fill="#282d25">GOOD WORK. THEN PAYMENT.</text></svg>`)).png().toFile(pngPath);
  const page = await newPage('checkout');
  await page.goto(webOrigin, { waitUntil: 'networkidle' });
  await page.getByRole('heading', { name: 'Good work. Then payment.' }).waitFor();
  await screenshot(page, 'desktop-start'); await assertResponsive(page);
  if (smokeOnly) {
    report.scope = 'Browser configuration and responsive smoke check only. No quote or transaction was created. Does not prove settlement or refund.';
    await page.setViewportSize({ width: 390, height: 844 }); await assertResponsive(page); await screenshot(page, 'mobile-start');
    if (captureJob) {
      const jobAddress = new PublicKey(captureJob).toBase58();
      await stop(worker); assert(worker); report.captureApiOffline = await apiOffline(worker);
      const recovered = await newPage('existing-recovery', true);
      await recovered.setViewportSize({ width: 390, height: 844 });
      await recovered.goto(`${webOrigin}/recover?job=${jobAddress}`, { waitUntil: 'networkidle' });
      await recovered.getByRole('button', { name: 'Connect wallet', exact: true }).click();
      await recovered.getByText('Refund complete. No merchant action was required.', { exact: true }).waitFor();
      await assertResponsive(recovered); await screenshot(recovered, 'mobile-existing-refunded');
      report.existingJobCaptured = await requireJob(connection, config, jobAddress);
    }
    assert.equal(pageErrors.length, 0, pageErrors.join('; '));
    await videos(); report.passed = true; report.finishedAt = new Date().toISOString();
    await checkpoint('smoke-passed-no-transactions');
  } else {
  await page.getByRole('button', { name: 'Connect wallet', exact: true }).click();
  const release = await quote(page, 'normal', pngPath);
  await funded(page, release);
  const approve = page.getByRole('button', { name: 'Approve & release 5 test USDC', exact: false });
  await until('persisted preview ready and approve enabled', () => approve.isEnabled());
  const resultPath = resolve(dataDir, 'orders', release.order.jobId, 'result.webp');
  const beforeApproval = await readFile(resultPath);
  assert.equal((await requireJob(connection, config, release.order.jobAddress)).state, 'Funded');
  release.resultPersistedBeforeApproval = { bytes: beforeApproval.length, sha256: hash(beforeApproval), onchainState: 'Funded' };
  await screenshot(page, 'desktop-preview');
  await page.setViewportSize({ width: 390, height: 844 }); await assertResponsive(page); await screenshot(page, 'mobile-preview');
  await page.setViewportSize({ width: 1440, height: 1000 });
  await checkpoint('release-preview-persisted-before-approval');
  await approve.click();
  await until('finalized Released state', async () => (await requireJob(connection, config, release.order.jobAddress)).state === 'Released');
  release.settlement = await transactionLink(page, 'Release payment to merchant');
  await recordFinalBalances(release, 'Released');
  const first = await downloaded(page, 1);
  assert.equal(first.sha256, hash(beforeApproval));
  release.firstDownload = first;
  await screenshot(page, 'desktop-released');
  await checkpoint('release-approved-and-downloaded-via-browser');
  assert(worker);
  const originalWorker = worker;
  await stop(originalWorker); release.backendRestart = { before: await apiOffline(originalWorker) };
  const restarted = await startWorker(75);
  assert.notEqual(originalWorker.record.pid, restarted.record.pid);
  await page.reload({ waitUntil: 'networkidle' });
  await page.getByRole('button', { name: 'Sign & download original WebP', exact: false }).waitFor();
  const second = await downloaded(page, 2); assert.equal(second.sha256, first.sha256);
  release.reloadDownload = { ...second, identicalBytes: true, restartedWorkerPid: restarted.record.pid, sameDataDir: true };
  await checkpoint('release-recovered-after-backend-restart-and-page-reload');
  await page.getByRole('button', { name: 'Start another job', exact: true }).click();
  const refund = await quote(page, 'stall', pngPath);
  await funded(page, refund);
  await page.getByText('The worker is deliberately stalled.', { exact: true }).waitFor();
  const recoveryHref = await page.getByRole('link', { name: 'Independent recovery', exact: false }).getAttribute('href');
  assert(recoveryHref?.startsWith('/recover?job=')); refund.recoveryLink = recoveryHref;
  await screenshot(page, 'desktop-stalled');
  assert(worker);
  await stop(worker); refund.apiOfflineBeforeRecovery = await apiOffline(worker);
  await page.close();
  const recoveryPage = await newPage('recovery', true);
  await recoveryPage.goto(`${webOrigin}${recoveryHref}`, { waitUntil: 'networkidle' });
  await recoveryPage.getByRole('heading', { name: 'Your deposit. Your way back.' }).waitFor();
  await recoveryPage.getByText('Recorded deposit', { exact: true }).waitFor();
  const refundButton = recoveryPage.getByRole('button', { name: /Refund (opens in|5)/ });
  refund.refundButtonInitiallyDisabled = !await refundButton.isEnabled();
  await screenshot(recoveryPage, 'desktop-recovery-waiting');
  await checkpoint('merchant-api-stopped-independent-recovery-reading-chain');
  await waitUntilChain(connection, refund.order.expiresAt, 240_000);
  await until('refund enabled by chain deadline', () => refundButton.isEnabled());
  refund.apiOfflineAtRefund = await apiOffline(worker);
  await refundButton.click();
  await until('finalized Refunded state', async () => (await requireJob(connection, config, refund.order.jobAddress)).state === 'Refunded');
  await recoveryPage.getByText('Refund complete. No merchant action was required.', { exact: true }).waitFor();
  refund.settlement = await transactionLink(recoveryPage, 'Refund deposit to original buyer');
  await recordFinalBalances(refund, 'Refunded');
  refund.apiOfflineAfterRefund = await apiOffline(worker);
  assert.equal(merchantRequestsOnRecovery.length, 0, 'Independent recovery called the merchant API.');
  assert.equal(pageErrors.length, 0, `Browser page errors: ${pageErrors.join('; ')}`);
  refund.merchantRequestsOnRecovery = 0;
  await screenshot(recoveryPage, 'desktop-refunded');
  await recoveryPage.setViewportSize({ width: 390, height: 844 }); await assertResponsive(recoveryPage); await screenshot(recoveryPage, 'mobile-refunded');
  await recoveryPage.setViewportSize({ width: 1440, height: 1000 });
  await checkpoint('refund-via-independent-browser-with-api-offline');
  await videos();
  report.passed = true; report.finishedAt = new Date().toISOString();
  await checkpoint('passed');
  }
} catch (error) {
  report.error = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
  for (const item of videoPages) if (!item.page.isClosed()) {
    await screenshot(item.page, `failure-${item.name}`).catch(() => {});
    const body = await item.page.locator('body').innerText().catch(() => 'Page unavailable');
    await writeFile(resolve(runDir, `failure-${item.name}.txt`), body);
  }
  await videos().catch(() => {});
  await checkpoint('failed');
  throw error;
} finally {
  await context?.close().catch(() => {}); await browser?.close().catch(() => {});
  await stop(worker); await stop(web);
  report.updatedAt = new Date().toISOString();
  await writeEvidence(evidenceName, report); await writeEvidence(`${evidenceName}-${runId}`, report);
  await writeEvidence(`${evidenceName}-progress`, report);
}
