import assert from 'node:assert/strict';
import { createPrivateKey, randomBytes, sign } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import test from 'node:test';
import BN from 'bn.js';
import sharp from 'sharp';
import { getAccount, getOrCreateAssociatedTokenAccount, mintTo } from '@solana/spl-token';
import { Keypair, SystemProgram, sendAndConfirmTransaction } from '@solana/web3.js';
import {
  CHECKOUT_IDL, Connection, PublicKey, Transaction, TOKEN_PROGRAM_ID,
  deriveConfigAddress, deriveJobAddress, deriveVaultAddress,
  fetchJob, instruction, meta, type PublicConfig, type TransactionInstruction,
} from '../../../packages/chain/src/index.js';
import { createWorker } from '../../../apps/worker/src/app.js';
import { createChainGateway } from '../../../apps/worker/src/chain.js';

// Fresh-review tests intentionally submit failed transactions, rather than
// counting rejected RPC simulations as evidence of ledger rollback.
test('adversarial review: submitted rollback and real-chain download authorization', { timeout: 180_000 }, async t => {
  const url = process.env.LOCAL_RPC_URL ?? 'http://127.0.0.1:8899';
  assert(['localhost', '127.0.0.1', '[::1]'].includes(new URL(url).hostname), 'Review suite is local-only');
  const connection = new Connection(url, 'confirmed');
  const genesis = await connection.getGenesisHash();
  assert(!['EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG', '5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp'].includes(genesis));
  const payer = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(await readFile('.local/keys/deployer.json', 'utf8'))));
  const addresses = JSON.parse(await readFile('.local/addresses.json', 'utf8'));
  const buyer = Keypair.generate();
  const merchant = Keypair.generate();
  const attacker = Keypair.generate();
  const config: PublicConfig = { rpcUrl: url, programId: addresses.program, mint: addresses.mint,
    merchant: merchant.publicKey.toBase58(), amount: '5000000', decimals: 6, cluster: 'localnet' };
  assert.equal(config.programId, CHECKOUT_IDL.address);
  assert((await connection.getAccountInfo(new PublicKey(config.programId)))?.executable);
  const mint = new PublicKey(config.mint);
  const programConfig = deriveConfigAddress(config);
  const amount = 5_000_000n;
  const send = (instructions: TransactionInstruction[], signers: Keypair[] = [buyer]) => sendAndConfirmTransaction(
    connection, new Transaction().add(...instructions), [payer, ...signers], { commitment: 'confirmed', preflightCommitment: 'confirmed' },
  );
  await send([SystemProgram.transfer({ fromPubkey: payer.publicKey, toPubkey: buyer.publicKey, lamports: 30_000_000 })], []);
  const buyerToken = (await getOrCreateAssociatedTokenAccount(connection, payer, mint, buyer.publicKey)).address;
  const merchantToken = (await getOrCreateAssociatedTokenAccount(connection, payer, mint, merchant.publicKey)).address;
  const attackerToken = (await getOrCreateAssociatedTokenAccount(connection, payer, mint, attacker.publicKey)).address;
  await mintTo(connection, payer, mint, buyerToken, payer, 100_000_000n);

  function addressesFor(id: string) {
    const job = deriveJobAddress(config, buyer.publicKey, id);
    return { job, vault: deriveVaultAddress(config, job) };
  }
  function fund(id: string, deadline: number, value = amount) {
    const { job, vault } = addressesFor(id);
    return instruction(config, 'fund', [meta(buyer.publicKey, true, true), meta(merchant.publicKey), meta(programConfig),
      meta(mint), meta(buyerToken, true), meta(merchantToken), meta(job, true), meta(vault, true), meta(TOKEN_PROGRAM_ID), meta(SystemProgram.programId)],
    { job_id: [...Buffer.from(id, 'hex')], amount: new BN(value.toString()), expires_at: new BN(deadline) });
  }
  function settle(id: string, action: 'approve' | 'refund', signer = buyer, destination?: PublicKey) {
    const { job, vault } = addressesFor(id);
    return instruction(config, action, [meta(signer.publicKey, false, true), meta(job, true), meta(vault, true), meta(mint),
      meta(destination ?? (action === 'approve' ? merchantToken : buyerToken), true), meta(TOKEN_PROGRAM_ID)]);
  }
  async function now() {
    const account = await connection.getAccountInfo(new PublicKey('SysvarC1ock11111111111111111111111111111111'), 'confirmed');
    assert(account);
    return Number(account.data.readBigInt64LE(32));
  }
  async function snapshot(id: string) {
    const keys = [buyer.publicKey, buyerToken, merchantToken, attackerToken, ...Object.values(addressesFor(id))];
    return (await connection.getMultipleAccountsInfo(keys, 'confirmed')).map(info => info ? {
      owner: info.owner.toBase58(), lamports: info.lamports, data: info.data.toString('base64'),
    } : null);
  }
  async function rejectedOnLedger(id: string, instructions: TransactionInstruction[], signers = [buyer], errorPattern?: RegExp) {
    const before = await snapshot(id);
    const latest = await connection.getLatestBlockhash('confirmed');
    const tx = new Transaction({ ...latest, feePayer: payer.publicKey }).add(...instructions);
    tx.sign(payer, ...signers);
    const signature = await connection.sendRawTransaction(tx.serialize(), { skipPreflight: true, maxRetries: 0 });
    const result = await connection.confirmTransaction({ ...latest, signature }, 'confirmed');
    assert(result.value.err, 'transaction must land and fail on the ledger');
    const landed = await connection.getTransaction(signature, { commitment: 'confirmed', maxSupportedTransactionVersion: 0 });
    assert(landed?.meta?.err, 'failed transaction metadata must exist');
    if (errorPattern) assert.match(landed.meta.logMessages?.join('\n') ?? '', errorPattern);
    assert(landed.meta.fee > 0);
    assert.equal(landed.meta.preBalances[0]! - landed.meta.postBalances[0]!, landed.meta.fee, 'fee payer loses only network fees');
    assert.deepEqual(await snapshot(id), before, 'every isolated token/job/vault field and rent balance must roll back');
    t.diagnostic(JSON.stringify({ rejectedOnLedger: signature, error: landed.meta.err, feeLamports: landed.meta.fee }));
    return signature;
  }

  const releaseId = randomBytes(32).toString('hex');
  const releaseDeadline = await now() + 180;
  await t.test('submitted insufficient-funds CPI failure rolls back job, vault, buyer rent and token balances', async () => {
    await rejectedOnLedger(releaseId, [fund(releaseId, releaseDeadline, 1_000_000_000n)], [buyer], /insufficient funds/i);
    assert.equal(await connection.getAccountInfo(addressesFor(releaseId).job), null);
    assert.equal(await connection.getAccountInfo(addressesFor(releaseId).vault), null);
  });
  await send([fund(releaseId, releaseDeadline)]);
  await t.test('approve followed by refund in one submitted transaction reverts the successful transfer too', async () => {
    await rejectedOnLedger(releaseId, [settle(releaseId, 'approve'), settle(releaseId, 'refund')], [buyer], /NotFunded/);
  });
  await t.test('submitted wrong-signer and wrong-destination approvals fail without mutation', async () => {
    await rejectedOnLedger(releaseId, [settle(releaseId, 'approve', attacker)], [attacker], /UnauthorizedBuyer/);
    await rejectedOnLedger(releaseId, [settle(releaseId, 'approve', buyer, attackerToken)], [buyer], /WrongDestination/);
  });
  await send([settle(releaseId, 'approve')]);
  await t.test('released job rejects a submitted replay', async () => {
    await rejectedOnLedger(releaseId, [settle(releaseId, 'approve')], [buyer], /NotFunded/);
    await rejectedOnLedger(releaseId, [fund(releaseId, releaseDeadline)]);
  });

  const refundId = randomBytes(32).toString('hex');
  const refundDeadline = await now() + 5;
  await send([fund(refundId, refundDeadline)]);
  while (await now() < refundDeadline) await delay(250);
  await t.test('late approval and refund followed by approve are submitted and roll back correctly', async () => {
    await rejectedOnLedger(refundId, [settle(refundId, 'approve')], [buyer], /ApprovalExpired/);
    await rejectedOnLedger(refundId, [settle(refundId, 'refund'), settle(refundId, 'approve')], [buyer], /NotFunded/);
    assert.equal((await getAccount(connection, addressesFor(refundId).vault)).amount, amount);
  });
  await send([settle(refundId, 'refund')]);
  await t.test('refunded job rejects a submitted competing approval and replay', async () => {
    await rejectedOnLedger(refundId, [settle(refundId, 'approve')], [buyer], /NotFunded/);
    await rejectedOnLedger(refundId, [settle(refundId, 'refund')], [buyer], /NotFunded/);
  });

  const dataDir = await mkdtemp(join(tmpdir(), 'holdfast-live-review-'));
  const settings = { dataDir, orderLifetimeSeconds: 180, challengeLifetimeSeconds: 60,
    challengeDomain: 'http://localhost:8787', corsOrigins: ['http://localhost:5173'] };
  const chain = createChainGateway(config);
  let worker = await createWorker({ chain, settings, logger: false });
  t.after(async () => { await worker.app.close(); await rm(dataDir, { recursive: true, force: true }); });
  const png = await sharp({ create: { width: 16, height: 16, channels: 4, background: '#17bfc1' } }).png().toBuffer();
  const order = await worker.service.create(buyer.publicKey.toBase58(), 'normal', png);
  await send([fund(order.jobId, order.expiresAt)]);
  const waitForState = async (state: 'Funded' | 'Released') => {
    const deadline = Date.now() + 45_000;
    while (Date.now() < deadline) {
      const job = await fetchJob(connection, config, order.jobAddress);
      if (job?.state === state) return;
      await delay(500);
    }
    throw new Error(`Job did not finalize as ${state}`);
  };
  await waitForState('Funded');
  await worker.service.read(order.jobId, true);
  await worker.service.waitForIdle();
  await t.test('actual finalized chain funding produces a durable WebP; download stays locked before release', async () => {
    assert.equal((await worker.service.read(order.jobId)).status, 'ready');
    const response = await worker.app.inject({ method: 'POST', url: `/api/orders/${order.jobId}/challenge`, payload: { buyer: order.buyer } });
    assert.equal(response.statusCode, 403);
  });
  await send([settle(order.jobId, 'approve')]);
  await waitForState('Released');
  const urlPrefix = `/api/orders/${order.jobId}`;
  const privateKey = createPrivateKey({ key: Buffer.concat([Buffer.from('302e020100300506032b657004220420', 'hex'), Buffer.from(buyer.secretKey.subarray(0, 32))]), format: 'der', type: 'pkcs8' });
  const attackerPrivateKey = createPrivateKey({ key: Buffer.concat([Buffer.from('302e020100300506032b657004220420', 'hex'), Buffer.from(attacker.secretKey.subarray(0, 32))]), format: 'der', type: 'pkcs8' });
  const challenge = async () => {
    const response = await worker.app.inject({ method: 'POST', url: `${urlPrefix}/challenge`, payload: { buyer: order.buyer } });
    assert.equal(response.statusCode, 200, response.body);
    return response.json<{ message: string; nonce: string; expiresAt: number }>();
  };
  const download = (value: { message: string; nonce: string }, privateSigningKey = privateKey) => worker.app.inject({ method: 'POST', url: `${urlPrefix}/download`, payload: {
    buyer: order.buyer, nonce: value.nonce, signature: sign(null, Buffer.from(value.message), privateSigningKey).toString('base64'),
  } });
  await t.test('wrong wallet cannot issue or forge a private download on a real Released purchase', async () => {
    assert.equal((await worker.app.inject({ method: 'POST', url: `${urlPrefix}/challenge`, payload: { buyer: attacker.publicKey.toBase58() } })).statusCode, 403);
    const value = await challenge();
    assert.equal((await download(value, attackerPrivateKey)).statusCode, 401);
  });
  await t.test('unauthenticated issuance preserves the pending buyer challenge and its original expiry', async () => {
    const original = await challenge();
    for (let i = 0; i < 8; i++) assert.deepEqual(await challenge(), original);
    assert.equal((await download(original)).statusCode, 200, 'public issuance must not evict a still-unexpired signed buyer nonce');
    assert.equal((await download(original)).statusCode, 401, 'reuse must still reject consumed signatures');
    assert.notEqual((await challenge()).nonce, original.nonce, 'consumption permits a fresh nonce');
    t.diagnostic('RESOLVED R1: repeated public issuance preserves the pending nonce/message/expiry; the original buyer signature succeeds once.');
  });
  await t.test('one signed nonce grants one download and consumption persists through a real worker restart', async () => {
    const value = await challenge();
    const attempts = await Promise.all([download(value), download(value)]);
    assert.deepEqual(attempts.map(response => response.statusCode).sort(), [200, 401]);
    assert.equal(attempts.find(response => response.statusCode === 200)!.headers['cache-control'], 'no-store');
    assert.equal((await sharp(attempts.find(response => response.statusCode === 200)!.rawPayload).metadata()).format, 'webp');
    await worker.app.close();
    worker = await createWorker({ chain, settings, logger: false });
    assert.equal((await download(value)).statusCode, 401);
    assert.equal((await worker.service.read(order.jobId)).status, 'released');
    assert.equal((await download(await challenge())).statusCode, 200);
    for (const path of [`${urlPrefix}/result.webp`, `/orders/${order.jobId}/result.webp`, `${urlPrefix}/input.png`]) {
      assert.equal((await worker.app.inject({ method: 'GET', url: path })).statusCode, 404);
    }
  });
  t.diagnostic(JSON.stringify({ program: config.programId, mint: config.mint, genesis,
    isolatedBuyer: buyer.publicKey.toBase58(), isolatedMerchant: merchant.publicKey.toBase58(),
    releaseJob: addressesFor(releaseId).job.toBase58(), refundJob: addressesFor(refundId).job.toBase58(), privateDownloadJob: order.jobAddress }));
});
