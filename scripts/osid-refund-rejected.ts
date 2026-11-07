import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';
import { buildRefundTransaction, fetchChainTime, getConnection, PublicKey, type Job } from '@holdfast/chain';
import { assertNetwork, balances, loadConfig, loadKey, requireJob, send, txEvidence, writeEvidence } from './common.js';

// Reconcile one recorded rejected disposable test purchase. No provider request,
// application session or merchant API is used to construct/authorize the refund.
const index = process.argv[2] ?? '1';
assert(/^[1-9][0-9]?$/.test(index) || ['interrupted','uncertain'].includes(index), 'Choose a recorded rejection number (default 1), interrupted or uncertain');
const suffix = index === '1' ? '' : `-${index}`;
const source = index==='uncertain' ? 'evidence/osid-live-ai-uncertain.json' : index==='interrupted' ? 'evidence/osid-live-ui-rpc-expired.json' : `evidence/osid-live-ai-rejected${suffix}.json`;
const evidenceName = index==='uncertain' ? 'osid-live-uncertain-refund' : index==='interrupted' ? 'osid-live-interrupted-refund' : `osid-live-rejected-refund${suffix}`;
const rejected = JSON.parse(await readFile(source, 'utf8')) as {
  job: Job; operatorDecision: { approved: boolean }; processes: { pid: number; exit?: unknown }[];
};
assert.equal(rejected.operatorDecision.approved, false);
assert(rejected.processes.every(process => process.exit), 'Original owned API/browser processes must have exited');
const config = await loadConfig('devnet'), connection = getConnection(config), buyer = await loadKey('osidbuyer');
const report: Record<string, unknown> = { schemaVersion: 2, startedAt: new Date().toISOString(), config,
  source, buyer: buyer.publicKey.toBase58(), passed: false,
  scope: 'Original buyer timeout refund of an immutable Funded or Submitted live-AI test job rejected before payment approval.',
  transport: 'Direct Solana SDK/RPC. Health probes below only establish that both merchant listeners are offline; refund authorization uses no merchant request or application session.' };

function code(error: unknown): unknown {
  if (error && typeof error === 'object') {
    if ('code' in error) return error.code;
    if ('cause' in error) return code(error.cause);
  }
  return undefined;
}
async function apiOffline() {
  const probes = [];
  for (const url of ['http://127.0.0.1:18790/health', 'http://127.0.0.1:8787/health']) {
    try { await fetch(url, { signal: AbortSignal.timeout(2000) }); throw new Error(`Merchant API responds at ${url}`); }
    catch (error) { assert.equal(code(error), 'ECONNREFUSED', 'A timeout does not prove API shutdown'); }
    probes.push({ url, result: 'ECONNREFUSED' });
  }
  return { at: new Date().toISOString(), probes };
}
function assertFrozen(job: Job) {
  for (const field of ['address', 'buyer', 'merchant', 'mint', 'provider', 'amount', 'expiresAt', 'termsHash', 'resultHash'] as const)
    assert.equal(job[field], rejected.job[field], `Rejected ${field} binding changed`);
  assert.equal(job.buyer, buyer.publicKey.toBase58());
  assert.equal(job.mint, config.mint); assert.equal(job.merchant, config.merchant);
  assert.equal(job.amount, config.amount); assert.equal(job.version, 2);
}
try {
  report.genesis = await assertNetwork(connection, config);
  const initial = await requireJob(connection, config, rejected.job.address); assertFrozen(initial);
  if (initial.state === 'Refunded') {
    let completed: { passed?: boolean; refundedJob?: Job } | undefined;
    try { completed=JSON.parse(await readFile(`evidence/${evidenceName}.json`,'utf8')); }
    catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;}
    if(completed?.passed && completed.refundedJob){
      assertFrozen(completed.refundedJob);assert.equal(completed.refundedJob.state,'Refunded');
      console.log('Already verified Refunded; retained original evidence and sent no transaction.');
    }else{
    let pending: { refund?: { signature: string }; before?: Awaited<ReturnType<typeof balances>>; apiOfflineBefore?: unknown; apiOfflineAtDeadline?: unknown } | undefined;
    try { pending=JSON.parse(await readFile(`evidence/${evidenceName}-blocked.json`,'utf8')); }
    catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;}
    if(pending?.refund?.signature && pending.before){
      const status=(await connection.getSignatureStatuses([pending.refund.signature],{searchTransactionHistory:true})).value[0];
      assert(status && status.confirmationStatus==='finalized' && status.err===null,'Recorded refund must be finalized');
      const after=await balances(connection,config,buyer.publicKey,new PublicKey(initial.vault));
      assert.equal(BigInt(after.buyer)-BigInt(pending.before.buyer),BigInt(config.amount));assert.equal(after.merchant,pending.before.merchant);
      assert.equal(pending.before.vault,config.amount);assert.equal(after.vault,'0');
      Object.assign(report,{reconciledAfterPostSettlementReadFailure:true,refund:pending.refund,before:pending.before,after,refundedJob:initial,
        apiOfflineBefore:pending.apiOfflineBefore,apiOfflineAtDeadline:pending.apiOfflineAtDeadline,apiOfflineAfter:await apiOffline(),passed:true,finishedAt:new Date().toISOString()});
      await writeEvidence(evidenceName,report);console.log(`PASS reconciled original refund without sending another transaction: ${pending.refund.signature}`);
    }else console.log('Rejected test job is already Refunded; no transaction sent and existing evidence retained.');
    }
  }
  else {
    assert(['Funded', 'Submitted'].includes(initial.state)); report.initialJob = initial;
    report.apiOfflineBefore = await apiOffline();
    console.log(`Waiting for rejected ${initial.state} job ${initial.address}; refund deadline ${new Date(initial.expiresAt * 1000).toISOString()}`);
    const stopAt = Date.now() + 35 * 60_000; let lastMinute: number | undefined;
    while (true) {
      const chainTime = await fetchChainTime(connection);
      if (chainTime >= initial.expiresAt) { report.chainTimeBeforeRefund = chainTime; break; }
      assert(Date.now() < stopAt, 'Bounded deadline wait expired; no replacement or refund transaction sent');
      const minute = Math.ceil((initial.expiresAt - chainTime) / 60);
      if (minute !== lastMinute) { console.log(`Refund eligibility in ${minute} chain minute(s)`); lastMinute = minute; }
      await delay(10_000);
    }
    report.apiOfflineAtDeadline = await apiOffline();
    const current = await requireJob(connection, config, initial.address); assertFrozen(current); assert.equal(current.state, initial.state);
    report.before = await balances(connection, config, buyer.publicKey, new PublicKey(current.vault));
    const signature = await send(connection, await buildRefundTransaction(connection, config, { buyer: buyer.publicKey, jobAddress: current.address }), [buyer]);
    report.refund = txEvidence(config, signature);
    const terminal = await requireJob(connection, config, initial.address); assertFrozen(terminal); assert.equal(terminal.state, 'Refunded');
    report.refundedJob = terminal;
    const before = report.before as Awaited<ReturnType<typeof balances>>, after = await balances(connection, config, buyer.publicKey, new PublicKey(terminal.vault));
    assert.equal(BigInt(after.buyer) - BigInt(before.buyer), BigInt(config.amount));
    assert.equal(after.merchant, before.merchant); assert.equal(before.vault, config.amount); assert.equal(after.vault, '0');
    report.after = after; report.apiOfflineAfter = await apiOffline(); report.passed = true; report.finishedAt = new Date().toISOString();
    await writeEvidence(evidenceName, report); console.log(`PASS rejected ${initial.state} refund: ${signature}`);
  }
} catch (error) {
  report.error = error instanceof Error ? error.message : String(error); report.finishedAt = new Date().toISOString();
  await writeEvidence(`${evidenceName}-blocked`, report); console.error(report.error); process.exitCode = 1;
}
