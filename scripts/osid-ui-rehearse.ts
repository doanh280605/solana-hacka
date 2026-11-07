import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { access, mkdir, readFile, writeFile } from 'node:fs/promises';
import { relative, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import type { Browser, BrowserContext, Page, Video } from 'playwright-core';
import { PublicKey, Transaction, deriveVaultAddress, fetchChainTime, getConnection } from '@holdfast/chain';
import { ROOT, assertNetwork, balances, clusterArg, loadConfig, loadKey, requireJob, txEvidence, writeEvidence } from './common.js';
import { base58 } from './keys.mjs';
import { assertOffline, hash, health, portUnused, sampleInput, signMessage, startProcess, startWorker, stopProcess, until, verifyBundle, type OrderV2, type OwnedProcess } from './osid-runtime.js';

// Only public keys and signature callbacks enter the isolated test browser.
const cluster = clusterArg(), fixture = process.argv.includes('--fixture'), smoke = process.argv.includes('--smoke');
const reviewGate = process.argv.includes('--review-gate');
const resumeId = process.argv.find(value => value.startsWith('--resume='))?.slice('--resume='.length);
assert(!resumeId || /^[0-9]{17}-[0-9a-f]{6}$/.test(resumeId), 'Resume requires an exact recorded run ID');
const previous = resumeId ? JSON.parse(await readFile(resolve(ROOT, 'evidence', `osid-ui-${cluster}${fixture ? '-fixture' : ''}-blocked.json`), 'utf8')) : undefined;
const executionSeconds = Number(process.env.OSID_UI_EXECUTION_SECONDS ?? 1800);
assert(Number.isSafeInteger(executionSeconds) && executionSeconds >= 900 && executionSeconds <= 3600, 'Browser rehearsal execution window must be 900–3600 seconds');
const config = await loadConfig(cluster); assert(config.provider);
const connection = getConnection(config), buyer = await loadKey('osidbuyer');
const runId = resumeId ?? `${new Date().toISOString().replace(/[^0-9]/g, '')}-${randomBytes(3).toString('hex')}`;
if (previous) {
  assert.equal(previous.runId, runId); assert.equal(previous.passed, false); assert.deepEqual(previous.config, config);
  assert.equal(previous.aiMode, fixture ? 'fixture' : 'live'); assert.equal(previous.signedTransactions.length, 1, 'Resume only before any approval signature');
  assert.equal(previous.operatorReview?.state, 'accepted', 'Resume only an exact already reviewed submission');
  assert(previous.processes.every((value: { exit?: unknown }) => value.exit), 'Previous owned servers must have exited');
}
const directory = resolve(ROOT, `.local/osid-ui-${cluster}-${runId}`);
const webPort = Number(process.env.OSID_UI_WEB_PORT ?? 15175), workerPort = Number(process.env.OSID_UI_WORKER_PORT ?? 18790);
const webOrigin = `http://127.0.0.1:${webPort}`, workerOrigin = `http://127.0.0.1:${workerPort}`;
const evidenceName = `osid-ui-${cluster}${fixture ? '-fixture' : ''}${smoke ? '-smoke' : ''}`;
const screenshots: string[] = previous?.screenshots ?? [], videos: string[] = [], errors: string[] = [], recoveryRequests: string[] = [], signedTransactions: unknown[] = previous?.signedTransactions ?? [], signedMessages: unknown[] = previous?.signedMessages ?? [], processes: unknown[] = previous?.processes ?? [];
const report: Record<string, unknown> = { schemaVersion: 2, runId, startedAt: new Date().toISOString(), config, aiMode: fixture ? 'fixture' : 'live',
  reviewGateEnabled: reviewGate,
  executionSeconds,
  wallet: 'Disposable injected test-wallet harness. Phantom extension not verified.', privateKeysInBrowser: false,
  scope: smoke ? 'Desktop/mobile page rendering only; no token movement.' : 'V2 browser quote/fund/review/approve/private download/reload; API-offline direct refund.',
  screenshots, videos, errors, recoveryRequests, signedTransactions, signedMessages, processes, passed: false,
  ...(previous ? { startedAt: previous.startedAt, resumedAt: new Date().toISOString(), resumption: { reason: previous.error, originalStage: previous.stage, previousReport: 'evidence/osid-live-ui-rpc-interruption.json', generationRepeated: false, fundingRepeated: false } } : {}) };
let browser: Browser | undefined, context: BrowserContext | undefined, worker: OwnedProcess | undefined, web: OwnedProcess | undefined;
const videoPages: { page: Page; video: Video | null; name: string }[] = [];
async function checkpoint(stage: string) { report.stage = stage; await writeEvidence(`${evidenceName}-progress`, report); console.log(`${evidenceName}: ${stage}`); }
async function screenshot(page: Page, name: string) {
  const path = resolve(ROOT, `evidence/screenshots/${evidenceName}-${name}.png`);
  // Chrome on macOS can tile the previous viewport if captured in the same
  // frame as a resize. Wait for actual fonts/images and two repaints.
  await page.evaluate(async () => {
    await document.fonts.ready;
    await Promise.all(Array.from(document.images).map(img => img.decode().catch(() => {})));
    await new Promise<void>(accept => requestAnimationFrame(() => requestAnimationFrame(() => accept())));
  });
  await page.screenshot({ path, fullPage: true, animations: 'disabled' }); if (!screenshots.includes(relative(ROOT,path))) screenshots.push(relative(ROOT, path));
  const size = await page.evaluate(() => ({ viewport: innerWidth, content: document.documentElement.scrollWidth }));
  assert(size.content <= size.viewport, `Horizontal overflow ${name}: ${JSON.stringify(size)}`);
}
async function page(name: string, recovery = false) {
  assert(context); const value = await context.newPage(); value.setDefaultTimeout(30_000);
  value.on('pageerror', error => errors.push(`${name}: ${error.message}`));
  if (recovery) value.on('request', request => { if (new URL(request.url()).origin === workerOrigin) recoveryRequests.push(request.url()); });
  videoPages.push({ page: value, name, video: value.video() }); return value;
}
async function injectWallet(ctx: BrowserContext) {
  await ctx.exposeFunction('__osidSignTransaction', async (encoded: string) => {
    const transaction = Transaction.from(Buffer.from(encoded, 'base64')); assert(transaction.feePayer?.equals(buyer.publicKey));
    const allowed = new Set([config.programId, '11111111111111111111111111111111', 'ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL', 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA']);
    assert(transaction.instructions.some(ix => ix.programId.toBase58() === config.programId));
    for (const ix of transaction.instructions) { assert(allowed.has(ix.programId.toBase58())); for (const key of ix.keys) if (key.isSigner) assert(key.pubkey.equals(buyer.publicKey)); }
    transaction.partialSign(buyer); const signature = transaction.signatures.find(s => s.publicKey.equals(buyer.publicKey))!.signature!;
    signedTransactions.push({ at: new Date().toISOString(), ...txEvidence(config, base58(signature)), programs: transaction.instructions.map(ix => ix.programId.toBase58()) }); return [...signature];
  });
  await ctx.exposeFunction('__osidSignMessage', async (bytes: number[]) => {
    const message = Buffer.from(bytes).toString(); assert(message.includes(buyer.publicKey.toBase58()));
    const login = message.includes('Sign in to osid (no payment authorization)') && message.includes(`URI: ${webOrigin}/app`);
    const download = message.includes('Purpose: download') && message.includes(`Domain: ${workerOrigin}`);
    assert(login || download, 'Harness signs only the expected login/download purposes');
    signedMessages.push({ at: new Date().toISOString(), purpose: login ? 'login' : 'download' }); return [...Buffer.from(signMessage(buyer, message), 'base64')];
  });
  await ctx.addInitScript(`(() => {
    if (location.origin !== ${JSON.stringify(webOrigin)}) return;
    const address = ${JSON.stringify(buyer.publicKey.toBase58())};
    const key = { toString: () => address, toBase58: () => address };
    const listeners = new Map();
    const trusted = () => localStorage.getItem('osid.harness.trusted') === 'yes';
    const provider = {
      publicKey: trusted() ? key : null,
      async connect(options) { if (options?.onlyIfTrusted && !trusted()) throw new Error('Connect test wallet explicitly'); localStorage.setItem('osid.harness.trusted','yes'); provider.publicKey=key; return {publicKey:key}; },
      async disconnect() { provider.publicKey=null; localStorage.removeItem('osid.harness.trusted'); listeners.get('disconnect')?.forEach(fn=>fn()); },
      on(event,fn) { if(!listeners.has(event)) listeners.set(event,new Set()); listeners.get(event).add(fn); },
      removeListener(event,fn) { listeners.get(event)?.delete(fn); },
      async signTransaction(tx) { const raw=tx.serialize({requireAllSignatures:false,verifySignatures:false}); const encoded=btoa(Array.from(raw,v=>String.fromCharCode(v)).join('')); tx.addSignature(tx.feePayer,Uint8Array.from(await window.__osidSignTransaction(encoded))); return tx; },
      async signMessage(bytes) { return {signature:Uint8Array.from(await window.__osidSignMessage([...bytes]))}; }
    }; window.solana=provider; window.phantom={solana:provider};
  })()`);
}
async function login(value: Page) {
  if (await value.getByRole('button', { name: 'Sign in with wallet', exact: true }).count() === 0) await value.getByRole('button', { name: 'Connect wallet', exact: true }).first().click();
  await value.getByRole('button', { name: 'Sign in with wallet', exact: true }).click();
  await value.getByRole('button', { name: 'Sign out', exact: true }).waitFor();
}
async function quote(value: Page, mode: 'normal' | 'stall', path: string): Promise<OrderV2> {
  await value.locator('#product-file').setInputFiles(path);
  await value.locator('#brief').fill('Morning candle. Cedar and amber scent. 250 g amber glass jar with black lid and cream Morning label. Preserve the exact product and label. Set it in a clean warm studio. Do not invent product facts, prices, burn time, certifications or safety claims.');
  if (mode === 'stall') { await value.getByText('Recovery rehearsal options', { exact: true }).click(); await value.getByRole('checkbox', { name: /Intentionally skip generation/ }).check(); }
  const pending = value.waitForResponse(r => r.url() === `${workerOrigin}/api/v2/orders` && r.request().method() === 'POST', { timeout: 240_000 });
  // Observe rejection immediately even if a disabled button makes click fail.
  void pending.catch(() => {});
  await value.getByRole('button', { name: 'Get quote', exact: true }).click();
  const response = await pending; assert.equal(response.status(), 201, await response.text()); const order = await response.json() as OrderV2;
  assert.equal(order.version, 2); assert.equal(order.aiMode, fixture ? 'fixture' : 'live'); return order;
}
async function fund(value: Page, order: OrderV2) {
  const vault = deriveVaultAddress(config, order.jobAddress), before = await balances(connection, config, buyer.publicKey, vault);
  await value.locator('#accept-specification').check(); const button = value.getByRole('button', { name: 'Fund 5 mock USDC', exact: true });
  await until('fund button enabled', () => button.isEnabled()); const signaturesBefore=signedTransactions.length; await button.click();
  await until('explicit buyer funding signature',async()=>signedTransactions.length>signaturesBefore);
  const job = await until('finalized funded job', async () => { if(cluster==='devnet')await delay(3000);const found = await requireJob(connection, config, order.jobAddress).catch(() => null); return found && ['Funded','Submitted'].includes(found.state) ? found : false; });
  const afterFund = await balances(connection, config, buyer.publicKey, vault);
  assert.equal(BigInt(before.buyer)-BigInt(afterFund.buyer),BigInt(config.amount)); assert.equal(before.merchant,afterFund.merchant); assert.equal(afterFund.vault,config.amount);
  return { before, afterFund, fundedJob: job };
}
async function download(value: Page, name: string, order: OrderV2) {
  const pending = value.waitForEvent('download'); void pending.catch(() => {});
  await value.getByRole('button', { name: 'Sign & download bundle', exact: true }).click();
  const result = await pending, path = resolve(directory, name); await result.saveAs(path); const bytes = await readFile(path);
  assert(order.manifest && order.resultHash); return { ...await verifyBundle(bytes, order.manifest, order.resultHash), path: relative(ROOT,path) };
}
async function reviewSubmitted(order: OrderV2) {
  if (!reviewGate) return;
  // This optional test-runner checkpoint lets the operator inspect real output
  // before the disposable buyer approves. It is outside the customer UI flow.
  const path = resolve(directory, 'review-decision.json');
  const binding = { runId, jobAddress: order.jobAddress, resultHash: order.resultHash };
  report.operatorReview = { ...binding, path: relative(ROOT, path), state: 'awaiting-review' };
  await checkpoint('submitted-awaiting-review');
  const decision = await until('operator review of exact submitted result', async () => {
    let value: { runId?: string; jobAddress?: string; resultHash?: string; approved?: boolean; reviewer?: string; notes?: string };
    try { value = JSON.parse(await readFile(path, 'utf8')); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false; throw error; }
    assert.equal(value.runId, binding.runId, 'Review belongs to another run');
    assert.equal(value.jobAddress, binding.jobAddress, 'Review belongs to another job');
    assert.equal(value.resultHash, binding.resultHash, 'Review belongs to another submitted result');
    if (value.approved !== true) {
      report.operatorReview = { ...binding, path: relative(ROOT, path), state: 'rejected', decision: value, rejectedAt: new Date().toISOString() };
      throw new Error('Operator rejected this submitted result; payment remains unreleased');
    }
    assert(typeof value.reviewer === 'string' && value.reviewer.trim(), 'Review must identify its operator');
    return value;
  }, Math.min(900_000, Math.max(1, order.expiresAt * 1000 - Date.now() - 60_000)));
  report.operatorReview = { ...binding, path: relative(ROOT, path), state: 'accepted', decision, acceptedAt: new Date().toISOString() };
  await checkpoint('submitted-review-accepted');
}

try {
  await mkdir(directory, { recursive:true, mode:0o700 }); await mkdir(resolve(ROOT,'evidence/screenshots'),{recursive:true});
  report.genesis = await assertNetwork(connection, config); await portUnused(webPort);
  if (previous) assert(await fetchChainTime(connection)<previous.release.quote.expiresAt,'Recorded job expired; refund it instead of attempting resumed approval');
  worker = await startWorker(config,directory,workerPort,webOrigin,fixture,executionSeconds); processes.push(worker.record);
  web = await startProcess('vite',[resolve(ROOT,'node_modules/vite/bin/vite.js'),'--host','127.0.0.1','--port',String(webPort),'--strictPort'],{
    PATH:process.env.PATH,TMPDIR:process.env.TMPDIR,VITE_RPC_URL:config.rpcUrl,VITE_PROGRAM_ID:config.programId,VITE_MINT:config.mint,
    VITE_MERCHANT:config.merchant,VITE_PROVIDER:config.provider,VITE_CLUSTER:cluster,VITE_WORKER_URL:workerOrigin,
  },directory,resolve(ROOT,'apps/web')); processes.push(web.record); await health(web,webOrigin);
  process.env.PLAYWRIGHT_BROWSERS_PATH=resolve(ROOT,'.local/playwright'); const {chromium}=await import('playwright-core');
  browser=await chromium.launch({headless:true,executablePath:process.env.UI_CHROME_PATH ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'});
  let videoReady=true; try {await access(resolve(process.env.PLAYWRIGHT_BROWSERS_PATH,'ffmpeg-1011/ffmpeg-mac'));} catch {videoReady=false;report.videoLimitation='Playwright ffmpeg missing';}
  context=await browser.newContext({viewport:{width:1440,height:1000},acceptDownloads:true,...(videoReady?{recordVideo:{dir:resolve(directory,'videos'),size:{width:1440,height:1000}}}:{})});
  await injectWallet(context); const main=await page('workspace'); await main.goto(webOrigin,{waitUntil:'networkidle'});
  await main.getByRole('heading',{name:/Approve the work/}).waitFor(); await screenshot(main,'landing-desktop');
  await main.setViewportSize({width:390,height:844}); await screenshot(main,'landing-mobile'); await main.setViewportSize({width:1440,height:1000});
  await main.goto(`${webOrigin}/demo`,{waitUntil:'networkidle'}); await main.getByText(/SAMPLE DEMO/).first().waitFor(); await screenshot(main,'demo-desktop');
  await main.goto(`${webOrigin}/app`,{waitUntil:'networkidle'}); await screenshot(main,'workspace-empty');
  await checkpoint('pages-rendered');
  if (!smoke) {
    await login(main); await checkpoint('wallet-authenticated'); const path=resolve(directory,'input.png');
    if (previous) assert.equal(hash(await readFile(path)),previous.release.quote.inputHash,'Retained source photo changed');
    else await writeFile(path,await sampleInput());
    const order:OrderV2=previous?.release.quote ?? await quote(main,'normal',path);
    const release:Record<string,unknown>=previous?.release ?? {quote:order};report.release=release;
    if (previous) {
      const frozen = await requireJob(connection,config,order.jobAddress); assert.equal(frozen.state,'Submitted');
      assert.equal(frozen.resultHash,previous.operatorReview.resultHash); assert.equal(frozen.address,previous.operatorReview.jobAddress);
      await checkpoint('resumed-reviewed-submission-without-regeneration');
    } else {
      await screenshot(main,'agreement'); await checkpoint('quote-visible-before-funding');
      Object.assign(release,await fund(main,order)); await checkpoint('funded-via-wallet');
    }
    await Promise.race([
      main.locator('#approve-review').waitFor({state:'visible',timeout:fixture?240_000:900_000}),
      main.getByRole('heading',{name:'Generation needs attention',exact:true}).waitFor({state:'visible',timeout:fixture?240_000:900_000})
        .then(async()=>{throw new Error(`Generation failed before approval: ${await main.locator('.generation-panel').innerText().catch(()=> 'Inspect the preserved private order and provider attempt')}`);}),
    ]);
    const ready=await main.evaluate(async (url:string)=>{const r=await fetch(url,{credentials:'include'});return r.json();},`${workerOrigin}/api/v2/orders/${order.jobId}`) as OrderV2;
    assert(ready.resultHash&&ready.manifest&&ready.validation?.passed); const submitted=await requireJob(connection,config,order.jobAddress);assert.equal(submitted.state,'Submitted');assert.equal(submitted.resultHash,ready.resultHash);release.submittedJob=submitted;release.submitted=ready;
    await main.locator('.private-preview img').last().waitFor();await screenshot(main,'review-desktop');await main.setViewportSize({width:390,height:844});await screenshot(main,'review-mobile');await main.setViewportSize({width:1440,height:1000});
    await reviewSubmitted(ready);
    await main.locator('#approve-review').check();const approve=main.getByRole('button',{name:'Approve & release 5 mock USDC',exact:true});await until('approval enabled',()=>approve.isEnabled());await approve.click();
    await until('explicit buyer approval signature',async()=>signedTransactions.length===2);
    const released=await until('finalized release',async()=>{if(cluster==='devnet')await delay(3000);const found=await requireJob(connection,config,order.jobAddress);return found.state==='Released'?found:false;});release.releasedJob=released;
    await main.getByRole('button',{name:'Sign & download bundle',exact:true}).waitFor();release.download=await download(main,'bundle-first.zip',ready);await screenshot(main,'released');
    const after=await balances(connection,config,buyer.publicKey,new PublicKey(released.vault));const afterFund=release.afterFund as Awaited<ReturnType<typeof balances>>;
    assert.equal(after.buyer,afterFund.buyer);assert.equal(BigInt(after.merchant)-BigInt(afterFund.merchant),BigInt(config.amount));assert.equal(after.vault,'0');release.after=after;
    await stopProcess(worker);worker=await startWorker(config,directory,workerPort,webOrigin,fixture,executionSeconds);processes.push(worker.record);
    await main.reload({waitUntil:'networkidle'});await main.getByRole('button',{name:'Sign & download bundle',exact:true}).waitFor();release.reloadDownload=await download(main,'bundle-reloaded.zip',ready);
    assert.equal((release.download as {sha256:string}).sha256,(release.reloadDownload as {sha256:string}).sha256);await checkpoint('download-and-reload-verified');
    await stopProcess(worker);worker=await startWorker(config,directory,workerPort,webOrigin,fixture,cluster==='devnet'?120:65);processes.push(worker.record);
    await main.getByRole('button',{name:'Start another pack',exact:true}).click();const refundQuote=await quote(main,'stall',path);const refund:Record<string,unknown>={quote:refundQuote};report.refund=refund;
    Object.assign(refund,await fund(main,refundQuote));await checkpoint('stalled-job-funded');await stopProcess(worker);refund.apiOfflineBefore=await assertOffline(worker,workerOrigin);
    const recovery=await page('recovery',true);await recovery.goto(`${webOrigin}/recover?job=${refundQuote.jobAddress}`,{waitUntil:'networkidle'});await recovery.getByRole('heading',{name:/Your deposit/}).waitFor();
    await screenshot(recovery,'recovery-before');const refundButton=recovery.getByRole('button',{name:'Refund 5.00 mock USDC',exact:true});await until('refund available after deadline',async()=>await refundButton.count()>0&&await refundButton.isEnabled(),240_000);
    refund.apiOfflineAtDeadline=await assertOffline(worker,workerOrigin);await refundButton.click();
    await until('explicit original buyer refund signature',async()=>signedTransactions.length===4);
    const refunded=await until('finalized refund',async()=>{if(cluster==='devnet')await delay(3000);const found=await requireJob(connection,config,refundQuote.jobAddress);return found.state==='Refunded'?found:false;});refund.refundedJob=refunded;
    await recovery.getByText('Refund complete. No merchant action was required.',{exact:true}).waitFor();await screenshot(recovery,'refunded-desktop');await recovery.setViewportSize({width:390,height:844});await screenshot(recovery,'refunded-mobile');
    const refundAfter=await balances(connection,config,buyer.publicKey,new PublicKey(refunded.vault));const before=refund.before as Awaited<ReturnType<typeof balances>>;assert.equal(refundAfter.buyer,before.buyer);assert.equal(refundAfter.merchant,before.merchant);assert.equal(refundAfter.vault,'0');refund.after=refundAfter;refund.apiOfflineAfter=await assertOffline(worker,workerOrigin);
    assert.equal(recoveryRequests.length,0);assert.equal(signedTransactions.length,4);refund.merchantRequests=0;
  }
  assert.deepEqual(errors,[]);report.passed=true;report.finishedAt=new Date().toISOString();await checkpoint('complete');
} catch(error) {
  report.error=error instanceof Error?error.message:String(error);console.error(report.error);process.exitCode=1;
  for(const item of videoPages) if(!item.page.isClosed()) {
    try {
      await item.page.screenshot({path:resolve(directory,`failure-${item.name}.png`)});
      await writeFile(resolve(directory,`failure-${item.name}.txt`),await item.page.locator('body').innerText({timeout:3000}),{mode:0o600});
    } catch { /* The original error remains authoritative if the page crashed. */ }
  }
}
finally {
  async function cleanup(label: string, action: () => Promise<unknown>) {
    try { await action(); } catch(error) { report.passed=false;process.exitCode=1;errors.push(`${label}: ${error instanceof Error?error.message:String(error)}`); }
  }
  for(const item of videoPages){
    if(!item.page.isClosed())await cleanup(`close ${item.name}`,()=>item.page.close());
    if(item.video){const target=resolve(ROOT,`evidence/${evidenceName}-${item.name}.webm`);await cleanup(`video ${item.name}`,async()=>{await item.video!.saveAs(target);videos.push(relative(ROOT,target));});}
  }
  await cleanup('context close',async()=>context?.close());await cleanup('browser close',async()=>browser?.close());
  await cleanup('worker stop',()=>stopProcess(worker));await cleanup('web stop',()=>stopProcess(web));
  await writeEvidence(`${evidenceName}${report.passed?'':'-blocked'}`,report);
}
