import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { relative, resolve } from 'node:path';
import { PublicKey, buildApproveV2Transaction, buildFundV2Transaction, buildRefundTransaction, computeTermsHash, deriveVaultAddress, fetchChainTime, getConnection, hashCanonical } from '@holdfast/chain';
import { ROOT, assertNetwork, balances, clusterArg, loadConfig, loadKey, requireJob, send, txEvidence, waitUntilChain, writeEvidence } from './common.js';
import { ApiClient, assertOffline, hash, sampleInput, startWorker, stopProcess, until, verifyBundle, verifyPreviews, type OwnedProcess, type OrderV2 } from './osid-runtime.js';

const cluster = clusterArg();
const fixture = process.argv.includes('--fixture');
const config = await loadConfig(cluster); assert(config.provider, 'Run npm run keys then deployment to configure dedicated provider');
const connection = getConnection(config);
const buyer = await loadKey('osidbuyer'), attacker = await loadKey('osidattacker');
const runId = `${new Date().toISOString().replace(/[^0-9]/g, '')}-${randomBytes(3).toString('hex')}`;
const directory = resolve(ROOT, `.local/osid-rehearsal-${cluster}-${runId}`);
const port = Number(process.env.OSID_REHEARSAL_PORT ?? 18789);
const workerOrigin = `http://127.0.0.1:${port}`, webOrigin = 'http://127.0.0.1:15174';
const evidenceName = `osid-rehearsal-${cluster}${fixture ? '-fixture' : ''}`;
const processes: unknown[] = [];
const report: Record<string, unknown> = { schemaVersion: 2, runId, startedAt: new Date().toISOString(), cluster, config, aiMode: fixture ? 'fixture' : 'live',
  scope: fixture ? 'Real V2 chain/API/storage flow with explicitly deterministic fixture AI; not live AI proof.' : 'Runtime OpenAI specification, source image edit and listing generation through HTTP service; real V2 settlement and private delivery.',
  dataDirectory: relative(ROOT, directory), buyer: buyer.publicKey.toBase58(), processes, passed: false };
let worker: OwnedProcess | undefined;
let api = new ApiClient(workerOrigin, webOrigin);
async function checkpoint(stage: string) { report.stage = stage; await writeEvidence(`${evidenceName}-progress`, report); console.log(`osid ${cluster} ${fixture ? 'fixture' : 'live'}: ${stage}`); }
async function funded(order: OrderV2) {
  assert.equal(order.version, 2); assert.equal(order.aiMode, fixture ? 'fixture' : 'live');
  assert.equal(order.specHash, await hashCanonical(order.specification));
  const terms = { ...order, programId: config.programId };
  assert.equal(order.termsHash, await computeTermsHash(terms));
  const vault = deriveVaultAddress(config, order.jobAddress);
  const before = await balances(connection, config, buyer.publicKey, vault);
  const transaction = await buildFundV2Transaction(connection, config, { buyer: buyer.publicKey, jobId: order.jobId,
    expiresAt: order.expiresAt, quoteExpiresAt: order.quoteExpiresAt, inputHash: order.inputHash, specHash: order.specHash, termsHash: order.termsHash });
  const signature = await send(connection, transaction, [buyer]);
  const job = await requireJob(connection, config, order.jobAddress);
  assert.equal(job.state, 'Funded'); assert.equal(job.termsHash, order.termsHash); assert.equal(job.provider, config.provider);
  const afterFund = await balances(connection, config, buyer.publicKey, vault);
  assert.equal(BigInt(before.buyer) - BigInt(afterFund.buyer), BigInt(config.amount)); assert.equal(before.merchant, afterFund.merchant); assert.equal(afterFund.vault, config.amount);
  return { quote: order, fund: txEvidence(config, signature), fundedJob: job, vault: vault.toBase58(), before, afterFund };
}
async function current(order: OrderV2) { return api.json<OrderV2>(`/api/v2/orders/${order.jobId}`); }

try {
  await mkdir(directory, { recursive: true, mode: 0o700 }); report.genesis = await assertNetwork(connection, config);
  worker = await startWorker(config, directory, port, webOrigin, fixture); processes.push(worker.record);
  report.login = await api.login(buyer);
  const noSession = await new ApiClient(workerOrigin, webOrigin).response('/api/v2/orders'); assert.equal(noSession.status, 401);
  const input = await sampleInput(); await writeFile(resolve(directory, 'input.png'), input); report.input = { sha256: hash(input), bytes: input.length, source: 'Labeled sample product image' };
  await checkpoint('authenticated-before-quote');
  const quote = await api.quote(buyer, input); const release: Record<string, unknown> = { quote }; report.release = release;
  assert.equal(quote.inputHash, hash(input)); await checkpoint('quote-saved-before-funding');
  Object.assign(release, await funded(quote)); await checkpoint('normal-finalized-funded');
  await api.post(`/api/v2/orders/${quote.jobId}/funded`, { signature: (release.fund as { signature: string }).signature });
  const ready = await until<OrderV2>('durable submitted pack', async () => {
    const order = await current(quote);
    if (order.status === 'failed') throw new Error(`AI job failed: ${order.error}`);
    return order.status === 'ready' ? order : false;
  }, fixture ? 180_000 : 900_000);
  assert(ready.manifest && ready.resultHash && ready.validation?.passed && ready.listing && ready.previews?.length === 4);
  const submitted = await requireJob(connection, config, quote.jobAddress); assert.equal(submitted.state, 'Submitted'); assert.equal(submitted.resultHash, ready.resultHash);
  assert.equal(ready.resultHash, await hashCanonical(ready.manifest));
  release.submitted = ready; release.submittedJob = submitted;
  release.previews = await verifyPreviews(api, ready);
  const early = await api.response(`/api/v2/orders/${quote.jobId}/challenge`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ buyer: buyer.publicKey.toBase58() }) }); assert.equal(early.status, 403);
  const other = new ApiClient(workerOrigin, webOrigin); report.otherWalletLogin = await other.login(attacker);
  const denied = await other.response(`/api/v2/orders/${quote.jobId}`); assert.equal(denied.status, 403);
  const privateDenied = await other.response(`/api/v2/orders/${quote.jobId}/preview/hero`); assert.equal(privateDenied.status, 403);
  release.authorizationChecks = { privateBeforeRelease: early.status, otherWalletOrder: denied.status, otherWalletPreview: privateDenied.status };
  await checkpoint('durable-pack-and-confirmed-submission');
  // Restart before approval: paid generation cannot be silently repeated.
  const attemptsBefore = ready.attempts; await stopProcess(worker);
  worker = await startWorker(config, directory, port, webOrigin, fixture); processes.push(worker.record);
  const resumed = await current(quote); assert.equal(resumed.resultHash, ready.resultHash); assert.deepEqual(resumed.attempts, attemptsBefore);
  const transaction = await buildApproveV2Transaction(connection, config, { buyer: buyer.publicKey, jobAddress: quote.jobAddress, resultHash: ready.resultHash });
  const approval = await send(connection, transaction, [buyer]); release.approval = txEvidence(config, approval);
  const released = await requireJob(connection, config, quote.jobAddress); assert.equal(released.state, 'Released'); release.releasedJob = released;
  const after = await balances(connection, config, buyer.publicKey, new PublicKey(released.vault));
  const afterFund = release.afterFund as Awaited<ReturnType<typeof balances>>;
  assert.equal(after.buyer, afterFund.buyer); assert.equal(BigInt(after.merchant) - BigInt(afterFund.merchant), BigInt(config.amount)); assert.equal(after.vault, '0'); release.after = after;
  const bundle = await api.download(ready, buyer); await writeFile(resolve(directory, 'bundle.zip'), bundle); release.bundle = await verifyBundle(bundle, ready.manifest, ready.resultHash);
  await stopProcess(worker); worker = await startWorker(config, directory, port, webOrigin, fixture); processes.push(worker.record);
  assert.equal((await api.json<{ wallet: string }>('/api/auth/session')).wallet, buyer.publicKey.toBase58());
  const second = await api.download(await current(quote), buyer); assert(second.equals(bundle));
  assert.deepEqual((await current(quote)).attempts, attemptsBefore); release.restart = { persistedSession: true, identicalDownload: true, noAdditionalGenerationAttempts: true };
  await checkpoint('released-private-download-and-restart-verified');
  // Separate short-deadline stalled order. Worker exits before recovery begins.
  await stopProcess(worker); worker = await startWorker(config, directory, port, webOrigin, fixture, cluster === 'devnet' ? 120 : 60); processes.push(worker.record);
  api = new ApiClient(workerOrigin, webOrigin); await api.login(buyer);
  const refundQuote = await api.quote(buyer, input, 'stall'); const refund: Record<string, unknown> = { quote: refundQuote }; report.refund = refund;
  Object.assign(refund, await funded(refundQuote)); await api.post(`/api/v2/orders/${refundQuote.jobId}/funded`, {});
  await checkpoint('refund-job-funded-before-api-exit'); await stopProcess(worker);
  refund.apiOfflineBefore = await assertOffline(worker, workerOrigin);
  await waitUntilChain(connection, refundQuote.expiresAt, 300_000);
  refund.chainTime = await fetchChainTime(connection); refund.apiOfflineAtDeadline = await assertOffline(worker, workerOrigin);
  const refundTransaction = await buildRefundTransaction(connection, config, { buyer: buyer.publicKey, jobAddress: refundQuote.jobAddress });
  const refundSignature = await send(connection, refundTransaction, [buyer]); refund.transaction = txEvidence(config, refundSignature);
  const refunded = await requireJob(connection, config, refundQuote.jobAddress); assert.equal(refunded.state, 'Refunded'); refund.refundedJob = refunded;
  const refundAfter = await balances(connection, config, buyer.publicKey, new PublicKey(refunded.vault));
  const refundBefore = refund.before as Awaited<ReturnType<typeof balances>>;
  assert.equal(refundAfter.buyer, refundBefore.buyer); assert.equal(refundAfter.merchant, refundBefore.merchant); assert.equal(refundAfter.vault, '0'); refund.after = refundAfter;
  refund.apiOfflineAfter = await assertOffline(worker, workerOrigin);
  refund.recoveryTransport = 'Direct shared Solana SDK/RPC only. API health probes are separate instrumentation; the browser rehearsal records the actual merchant request count.';
  report.passed = true; report.finishedAt = new Date().toISOString(); await checkpoint('complete'); await writeEvidence(evidenceName, report);
  console.log(`PASS ${evidenceName}; bundle ${relative(ROOT, resolve(directory, 'bundle.zip'))}`);
} catch (error) {
  report.error = error instanceof Error ? error.message : String(error); report.finishedAt = new Date().toISOString();
  await writeEvidence(`${evidenceName}-blocked`, report); console.error(report.error); process.exitCode = 1;
} finally {
  try { await stopProcess(worker); }
  catch(error) { report.passed=false;report.cleanupError=error instanceof Error?error.message:String(error);process.exitCode=1; }
  await writeEvidence(`${evidenceName}${report.passed?'':'-blocked'}`, report);
}
