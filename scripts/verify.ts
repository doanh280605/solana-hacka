import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import {
  PublicKey, getConnection, fetchChainTime, deriveJobAddress, deriveVaultAddress,
  buildFundTransaction, buildApproveTransaction, buildRefundTransaction,
} from '@holdfast/chain';
import {
  clusterArg, loadConfig, loadKey, assertNetwork, send, balances, requireJob,
  writeEvidence, txEvidence, waitUntilChain,
} from './common.js';

const cluster = clusterArg();
const config = await loadConfig(cluster);
const connection = getConnection(config);
const buyer = await loadKey('buyer');
const report: Record<string, unknown> = { at: new Date().toISOString(), cluster, programId: config.programId,
  scope: 'Live chain client release and expiry refund; full product/offline process proof is in rehearsal evidence.',
  token: 'Mock USDC', decimals: 6, amount: config.amount, buyer: buyer.publicKey.toBase58() };
const checkpoint = async () => writeEvidence(`verify-${cluster}-progress`, report);

async function runPath(path: 'release' | 'refund') {
  const jobId = randomBytes(32).toString('hex');
  const jobAddress = deriveJobAddress(config, buyer.publicKey, jobId);
  const vault = deriveVaultAddress(config, jobAddress);
  const expiresAt = await fetchChainTime(connection) + (path === 'release' ? 300 : 75);
  const before = await balances(connection, config, buyer.publicKey, vault);
  const nativeBefore = await connection.getBalance(buyer.publicKey, 'finalized');
  const funded = await send(connection, await buildFundTransaction(connection, config, { buyer: buyer.publicKey, jobId, expiresAt }), [buyer]);
  const afterFund = await balances(connection, config, buyer.publicKey, vault);
  const job = await requireJob(connection, config, jobAddress);
  report[path] = { jobId, jobAddress: jobAddress.toBase58(), vault: vault.toBase58(), expiresAt, before, afterFund,
    fund: txEvidence(config, funded), state: job.state,
    recoveryLink: `/recover?job=${jobAddress.toBase58()}` };
  await checkpoint();
  assert.equal(job.state, 'Funded');
  assert.equal(job.amount, config.amount);
  assert.equal(job.buyer, buyer.publicKey.toBase58());
  assert.equal(job.merchant, config.merchant);
  assert.equal(job.mint, config.mint);
  assert.equal(job.expiresAt, expiresAt);
  assert.equal(BigInt(before.buyer) - BigInt(afterFund.buyer), BigInt(config.amount));
  assert.equal(afterFund.merchant, before.merchant);
  assert.equal(afterFund.vault, config.amount);
  console.log(`${path}: funded ${jobAddress.toBase58()} — ${funded}`);
  if (path === 'refund') await waitUntilChain(connection, expiresAt);
  const transaction = path === 'release'
    ? await buildApproveTransaction(connection, config, { buyer: buyer.publicKey, jobAddress })
    : await buildRefundTransaction(connection, config, { buyer: buyer.publicKey, jobAddress });
  const settled = await send(connection, transaction, [buyer]);
  const after = await balances(connection, config, buyer.publicKey, vault);
  const finalJob = await requireJob(connection, config, jobAddress);
  assert.equal(finalJob.state, path === 'release' ? 'Released' : 'Refunded');
  assert.equal(after.vault, '0');
  if (path === 'release') {
    assert.equal(after.buyer, afterFund.buyer);
    assert.equal(BigInt(after.merchant) - BigInt(before.merchant), BigInt(config.amount));
  } else {
    assert.equal(after.buyer, before.buyer);
    assert.equal(after.merchant, before.merchant);
  }
  const [fundMeta, settleMeta] = await Promise.all([
    connection.getTransaction(funded, { commitment: 'finalized', maxSupportedTransactionVersion: 0 }),
    connection.getTransaction(settled, { commitment: 'finalized', maxSupportedTransactionVersion: 0 }),
  ]);
  report[path] = { ...(report[path] as object), settle: txEvidence(config, settled), after, state: finalJob.state,
    feesLamports: { fund: fundMeta?.meta?.fee, settlement: settleMeta?.meta?.fee },
    buyerNativeLamports: { before: nativeBefore, after: await connection.getBalance(buyer.publicKey, 'finalized'),
      note: 'SOL includes transaction fees and account rent; SPL token balances above exclude both.' } };
  await checkpoint();
  console.log(`${path}: ${finalJob.state} — ${settled}`);
}

try {
  report.genesis = await assertNetwork(connection, config);
  const program = await connection.getAccountInfo(new PublicKey(config.programId), 'finalized');
  assert(program?.executable, 'Deploy the program first.');
  await runPath('release');
  await runPath('refund');
  report.passed = true;
  await writeEvidence(`verify-${cluster}`, report);
} catch (error) {
  report.passed = false;
  report.error = String(error);
  await checkpoint();
  throw error;
}
