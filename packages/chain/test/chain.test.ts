import assert from 'node:assert/strict';
import test from 'node:test';
import { randomBytes } from 'node:crypto';
import BN from 'bn.js';
import { BorshAccountsCoder } from '@coral-xyz/anchor';
import { Keypair } from '@solana/web3.js';
import { getAssociatedTokenAddressSync, TOKEN_PROGRAM_ID } from '@solana/spl-token';
import {
  CHECKOUT_IDL, PublicKey, type Connection, type PublicConfig, deriveJobAddress, deriveVaultAddress,
  fetchJob, fetchChainTime, buildRefundTransaction, buildApproveTransaction, jobIdBytes,
} from '../src/index.js';

const buyer = Keypair.generate().publicKey;
const merchant = Keypair.generate().publicKey;
const mint = Keypair.generate().publicKey;
const config: PublicConfig = { rpcUrl: 'http://127.0.0.1:8899', programId: CHECKOUT_IDL.address,
  mint: mint.toBase58(), merchant: merchant.toBase58(), decimals: 6, amount: '5000000', cluster: 'localnet' };
const id = randomBytes(32).toString('hex');
const jobAddress = deriveJobAddress(config, buyer, id);

async function fixture(state: 'Funded' | 'Released' | 'Refunded' = 'Funded', clockTime = 1000) {
  const coder = new BorshAccountsCoder(CHECKOUT_IDL);
  const bytes = await coder.encode('Job', {
    buyer, merchant, mint, job_id: [...jobIdBytes(id)], amount: new BN('5000000'), expires_at: new BN(1000),
    state: { [state]: {} }, bump: 255, vault_bump: 255,
  });
  const clock = Buffer.alloc(40); clock.writeBigInt64LE(BigInt(clockTime), 32);
  const commitments: unknown[] = [];
  const connection = {
    async getAccountInfo(address: PublicKey, commitment: unknown) {
      commitments.push(commitment);
      if (address.toBase58() === 'SysvarC1ock11111111111111111111111111111111') return { data: clock };
      return { data: bytes, owner: new PublicKey(config.programId), executable: false };
    },
    async getLatestBlockhash() { return { blockhash: '11111111111111111111111111111111', lastValidBlockHeight: 12345 }; },
  } as unknown as Connection;
  return { connection, bytes, commitments };
}

test('job IDs have a canonical non-ambiguous representation and are bound to the buyer', () => {
  assert.equal(jobIdBytes(id).length, 32);
  for (const malformed of ['', 'ab', 'g'.repeat(64), 'AB'.repeat(32), '../'.repeat(22)]) assert.throws(() => jobIdBytes(malformed));
  const otherBuyer = Keypair.generate().publicKey;
  assert(!deriveJobAddress(config, otherBuyer, id).equals(jobAddress));
  const expected = PublicKey.findProgramAddressSync([Buffer.from('job'), buyer.toBuffer(), Buffer.from(id, 'hex')], new PublicKey(config.programId))[0];
  assert(jobAddress.equals(expected));
});

test('job decoding verifies program ownership, correct PDA, and finalized commitment', async () => {
  const { connection, commitments } = await fixture();
  const job = await fetchJob(connection, config, jobAddress);
  assert.equal(job?.buyer, buyer.toBase58());
  assert.equal(job?.amount, '5000000');
  assert.equal(job?.expiresAt, 1000);
  assert.equal(job?.vault, deriveVaultAddress(config, jobAddress).toBase58());
  assert.deepEqual(commitments, ['finalized']);
  await assert.rejects(fetchJob(connection, config, Keypair.generate().publicKey), /address does not match/);
  const foreign = { getAccountInfo: async () => ({ owner: Keypair.generate().publicKey, executable: false }) } as unknown as Connection;
  await assert.rejects(fetchJob(foreign, config, jobAddress), /not a checkout job/);
});

test('chain time comes from finalized Clock sysvar bytes, with no wall-clock fallback', async () => {
  const { connection, commitments } = await fixture('Funded', 42);
  assert.equal(await fetchChainTime(connection), 42);
  assert.deepEqual(commitments, ['finalized']);
  const unavailable = { getAccountInfo: async () => null } as unknown as Connection;
  await assert.rejects(fetchChainTime(unavailable), /clock is unavailable/);
});

test('recovery uses recorded buyer/mint and canonical ATA at exact expiry, without merchant endpoints', async () => {
  const { connection } = await fixture('Funded', 1000);
  const otherConfig = { ...config, mint: Keypair.generate().publicKey.toBase58(), merchant: Keypair.generate().publicKey.toBase58() };
  const transaction = await buildRefundTransaction(connection, otherConfig, { buyer, jobAddress });
  const refund = transaction.instructions.at(-1)!;
  assert(refund.keys[0]!.pubkey.equals(buyer));
  assert(refund.keys[3]!.pubkey.equals(mint));
  assert(refund.keys[4]!.pubkey.equals(getAssociatedTokenAddressSync(mint, buyer)));
  assert(refund.keys[5]!.pubkey.equals(TOKEN_PROGRAM_ID));
  assert.equal(refund.keys[0]!.isSigner, true);
});

test('early refunds and nonbuyer recovery fail before a transaction is built', async () => {
  const { connection } = await fixture('Funded', 999);
  await assert.rejects(buildRefundTransaction(connection, config, { buyer, jobAddress }), /deadline has not arrived/);
  await assert.rejects(buildRefundTransaction(connection, config, { buyer: Keypair.generate().publicKey, jobAddress }), /original buyer/);
});

test('approval is allowed before expiry and blocked at equality; destination follows recorded merchant', async () => {
  const before = await fixture('Funded', 999);
  const transaction = await buildApproveTransaction(before.connection, config, { buyer, jobAddress });
  assert(transaction.instructions[0]!.keys[4]!.pubkey.equals(getAssociatedTokenAddressSync(mint, merchant)));
  const at = await fixture('Funded', 1000);
  await assert.rejects(buildApproveTransaction(at.connection, config, { buyer, jobAddress }), /deadline passed/);
});

test('terminal jobs cannot be approved or refunded again by the shared client', async () => {
  for (const state of ['Released', 'Refunded'] as const) {
    const { connection } = await fixture(state);
    await assert.rejects(buildRefundTransaction(connection, config, { buyer, jobAddress }), /already/);
    await assert.rejects(buildApproveTransaction(connection, config, { buyer, jobAddress }), /already/);
  }
});
