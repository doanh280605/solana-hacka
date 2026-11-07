import assert from 'node:assert/strict';
import test from 'node:test';
import { createHash } from 'node:crypto';
import BN from 'bn.js';
import { BorshAccountsCoder, BorshInstructionCoder } from '@coral-xyz/anchor';
import { Keypair, SystemProgram } from '@solana/web3.js';
import { getAssociatedTokenAddressSync } from '@solana/spl-token';
import {
  CHECKOUT_IDL, PublicKey, Transaction, type Connection, type PublicConfig, type JobState, type TermsV2,
  deriveJobAddress, deriveJobV2Address, deriveVaultAddress, canonicalJson, hashCanonical, computeTermsHash,
  fetchJob, buildFundV2Transaction, buildSubmitV2Transaction, buildApproveV2Transaction,
  buildApproveTransaction, buildRefundTransaction, validateConfig, transactionSignature,
} from '../src/index.js';

const buyer = Keypair.generate().publicKey, merchant = Keypair.generate().publicKey;
const provider = Keypair.generate().publicKey, mint = Keypair.generate().publicKey;
const config: PublicConfig = { rpcUrl: 'http://127.0.0.1:8899', programId: CHECKOUT_IDL.address,
  mint: mint.toBase58(), merchant: merchant.toBase58(), provider: provider.toBase58(),
  decimals: 6, amount: '5000000', cluster: 'localnet' };
const jobId = 'a1'.repeat(32), jobAddress = deriveJobV2Address(config, buyer, jobId);
const inputHash = 'b1'.repeat(32), specHash = 'c1'.repeat(32), resultHash = 'd1'.repeat(32);
const terms: TermsV2 = { programId: config.programId, jobAddress, jobId, buyer, merchant, provider, mint,
  amount: config.amount, expiresAt: 1800, quoteExpiresAt: 600, inputHash, specHash };

async function fixture(state: JobState = 'Funded', clockTime = 599, override: Record<string, unknown> = {}) {
  const termsHash = await computeTermsHash(terms);
  const bytes = await new BorshAccountsCoder(CHECKOUT_IDL).encode('JobV2', {
    schema_version: 2, buyer, merchant, provider, mint, job_id: [...Buffer.from(jobId, 'hex')],
    amount: new BN(config.amount), expires_at: new BN(1800), quote_expires_at: new BN(600),
    input_hash: [...Buffer.from(inputHash, 'hex')], spec_hash: [...Buffer.from(specHash, 'hex')],
    terms_hash: [...Buffer.from(termsHash, 'hex')],
    result_hash: [...Buffer.from(state === 'Funded' ? '00'.repeat(32) : resultHash, 'hex')],
    submitted_at: new BN(state === 'Funded' ? 0 : 500), state: { [state]: {} }, bump: 255, vault_bump: 255,
    ...override,
  });
  const clock = Buffer.alloc(40); clock.writeBigInt64LE(BigInt(clockTime), 32);
  const calls: { address: string; commitment: unknown }[] = [];
  const connection = {
    async getAccountInfo(address: PublicKey, commitment: unknown) {
      calls.push({ address: address.toBase58(), commitment });
      if (address.toBase58() === 'SysvarC1ock11111111111111111111111111111111') return { data: clock };
      return { data: bytes, owner: new PublicKey(config.programId), executable: false };
    },
    async getLatestBlockhash() { return { blockhash: SystemProgram.programId.toBase58(), lastValidBlockHeight: 100 }; },
  } as unknown as Connection;
  return { connection, bytes, calls, termsHash };
}
const decodedInstruction = (data: Buffer) => new BorshInstructionCoder(CHECKOUT_IDL).decode(data)!.name;

test('canonical JSON sorts by code units, preserves arrays and exact strings, and rejects ambiguous values', async () => {
  const value = { z: [true, null, { b: 'é', a: 'e\u0301' }], a: 1, 2: 'two', 10: 'ten' };
  const canonical = '{"10":"ten","2":"two","a":1,"z":[true,null,{"a":"é","b":"é"}]}';
  assert.equal(canonicalJson(value), canonical);
  assert.equal(await hashCanonical(value), createHash('sha256').update(canonical).digest('hex'));
  assert.notEqual(await hashCanonical('é'), await hashCanonical('e\u0301'));
  const cycle: { self?: unknown } = {}; cycle.self = cycle;
  const getter = Object.defineProperty({}, 'secret', { enumerable: true, get() { throw new Error('getter executed'); } });
  for (const bad of [undefined, NaN, Infinity, 0.5, Number.MAX_SAFE_INTEGER + 1, 1n, new Date(), new Uint8Array(1),
    { missing: undefined }, [undefined], new Array(1), cycle, getter, Symbol('x'), () => {}]) assert.throws(() => canonicalJson(bad));
  assert.equal(canonicalJson({ a: -0 }), '{"a":0}');
});

test('terms binary encoding matches Rust/Python vector and commits each agreement field', async () => {
  const key = (byte: number) => new PublicKey(new Uint8Array(32).fill(byte));
  const vector: TermsV2 = { programId: key(1), jobAddress: key(2), buyer: key(3), merchant: key(4), provider: key(5), mint: key(6),
    jobId: '07'.repeat(32), amount: '5000000', expiresAt: 1800, quoteExpiresAt: 600,
    inputHash: '08'.repeat(32), specHash: '09'.repeat(32) };
  assert.equal(await computeTermsHash(vector), '4ef1327c013d32194a79fb3394983e06aa8461d034cec78963ccbfa9c044b3a6');
  const hash = await computeTermsHash(terms);
  for (const field of ['programId', 'jobAddress', 'buyer', 'merchant', 'provider', 'mint'] as const) {
    assert.notEqual(await computeTermsHash({ ...terms, [field]: Keypair.generate().publicKey }), hash, field);
  }
  for (const change of [{ jobId: 'aa'.repeat(32) }, { amount: '5000001' }, { expiresAt: 1801 },
    { quoteExpiresAt: 601 }, { inputHash: 'ab'.repeat(32) }, { specHash: 'ac'.repeat(32) }]) {
    assert.notEqual(await computeTermsHash({ ...terms, ...change }), hash);
  }
  for (const change of [{ amount: '01' }, { amount: '0' }, { amount: '18446744073709551616' },
    { jobId: 'AA'.repeat(32) }, { inputHash: '00'.repeat(32) }, { specHash: 'no' }, { expiresAt: 0.1 }]) {
    await assert.rejects(computeTermsHash({ ...terms, ...change }));
  }
});

test('V2 decoding uses its own layout/PDA and verifies recomputed terms from finalized RPC', async () => {
  const { connection, calls } = await fixture('Submitted');
  const job = await fetchJob(connection, config, jobAddress);
  assert.equal(job?.version, 2); assert.equal(job?.state, 'Submitted');
  assert.equal(job?.provider, provider.toBase58()); assert.equal(job?.resultHash, resultHash);
  assert.equal(job?.inputHash, inputHash); assert.equal(job?.specHash, specHash);
  assert.equal(job?.quoteExpiresAt, 600); assert.equal(job?.submittedAt, 500);
  assert.equal(job?.vault, deriveVaultAddress(config, jobAddress).toBase58());
  assert.equal(calls.length, 1); assert.equal(calls[0]!.commitment, 'finalized');
  assert(!deriveJobAddress(config, buyer, jobId).equals(jobAddress));
  await assert.rejects(fetchJob(connection, config, deriveJobAddress(config, buyer, jobId)), /address does not match/);
});

test('decoder rejects unsupported schema, tampered terms, truncation, foreign owner and executable account', async () => {
  for (const override of [{ schema_version: 3 }, { input_hash: [...Buffer.alloc(32, 13)] },
    { spec_hash: [...Buffer.alloc(32, 14)] }, { amount: new BN('5000001') }]) {
    const { connection } = await fixture('Funded', 599, override);
    await assert.rejects(fetchJob(connection, config, jobAddress), /schema version|terms commitment/);
  }
  const { bytes } = await fixture();
  for (const info of [{ data: bytes.subarray(0, -1), owner: new PublicKey(config.programId), executable: false },
    { data: bytes, owner: Keypair.generate().publicKey, executable: false },
    { data: bytes, owner: new PublicKey(config.programId), executable: true }]) {
    await assert.rejects(fetchJob({ getAccountInfo: async () => info } as unknown as Connection, config, jobAddress));
  }
});

test('funding requires trusted provider, exact specification/terms and an unexpired quote', async () => {
  const { connection, termsHash } = await fixture();
  const input = { buyer, jobId, expiresAt: terms.expiresAt, quoteExpiresAt: terms.quoteExpiresAt, inputHash, specHash, termsHash };
  const tx = await buildFundV2Transaction(connection, config, input), fund = tx.instructions.at(-1)!;
  assert.equal(decodedInstruction(fund.data), 'fund_v2');
  assert(fund.keys[2]!.pubkey.equals(provider)); assert(fund.keys[7]!.pubkey.equals(jobAddress));
  assert.equal(fund.keys[0]!.isSigner, true); assert.equal(fund.keys[2]!.isSigner, false); assert.equal(tx.instructions.length, 3);
  await assert.rejects(buildFundV2Transaction(connection, { ...config, provider: undefined }, input), /trusted provider/);
  await assert.rejects(buildFundV2Transaction(connection, config, { ...input, provider: Keypair.generate().publicKey }), /provider/);
  await assert.rejects(buildFundV2Transaction(connection, config, { ...input, amount: '1' }), /amount/);
  await assert.rejects(buildFundV2Transaction(connection, config, { ...input, specHash: resultHash }), /terms commitment/);
  await assert.rejects(buildFundV2Transaction(connection, config, { ...input, termsHash: resultHash }), /terms commitment/);
  const at = await fixture('Funded', 600);
  await assert.rejects(buildFundV2Transaction(at.connection, config, input), /quote has expired/);
  assert.throws(() => validateConfig({ ...config, provider: PublicKey.default.toBase58() }), /nonzero/);
  assert.doesNotThrow(() => validateConfig({ ...config, provider: undefined }));
});

test('submission requires recorded provider, Funded state, nonzero hash and time before expiry', async () => {
  const { connection } = await fixture();
  const tx = await buildSubmitV2Transaction(connection, config, { provider, jobAddress, resultHash });
  assert(tx.feePayer?.equals(provider)); assert.equal(tx.instructions[0]!.keys.length, 2);
  assert.equal(decodedInstruction(tx.instructions[0]!.data), 'submit_v2');
  await assert.rejects(buildSubmitV2Transaction(connection, config, { provider: buyer, jobAddress, resultHash }), /recorded provider/);
  await assert.rejects(buildSubmitV2Transaction(connection, config, { provider, jobAddress, resultHash: '00'.repeat(32) }), /nonzero/);
  for (const state of ['Submitted', 'Released', 'Refunded'] as const) {
    const setup = await fixture(state);
    await assert.rejects(buildSubmitV2Transaction(setup.connection, config, { provider, jobAddress, resultHash }), /already submitted|terminal/);
  }
  const at = await fixture('Funded', 1800);
  await assert.rejects(buildSubmitV2Transaction(at.connection, config, { provider, jobAddress, resultHash }), /deadline passed/);
});

test('approval requires frozen result commitment, original buyer and time strictly before expiry', async () => {
  const { connection } = await fixture('Submitted', 1799);
  const changedConfig = { ...config, merchant: Keypair.generate().publicKey.toBase58(), mint: Keypair.generate().publicKey.toBase58() };
  const tx = await buildApproveV2Transaction(connection, changedConfig, { buyer, jobAddress, resultHash });
  assert(tx.instructions[0]!.keys[4]!.pubkey.equals(getAssociatedTokenAddressSync(mint, merchant)));
  assert.equal(decodedInstruction(tx.instructions[0]!.data), 'approve_v2');
  await assert.rejects(buildApproveV2Transaction(connection, config, { buyer: provider, jobAddress, resultHash }), /original buyer/);
  await assert.rejects(buildApproveV2Transaction(connection, config, { buyer, jobAddress, resultHash: specHash }), /commitment differs/);
  await assert.rejects(buildApproveTransaction(connection, config, { buyer, jobAddress }), /exact result commitment/);
  const before = await fixture();
  await assert.rejects(buildApproveV2Transaction(before.connection, config, { buyer, jobAddress, resultHash }), /submit the result/);
  const at = await fixture('Submitted', 1800);
  await assert.rejects(buildApproveV2Transaction(at.connection, config, { buyer, jobAddress, resultHash }), /deadline passed/);
});

test('independent recovery auto-detects both V2 pending states at equality using recorded mint and buyer ATA', async () => {
  for (const state of ['Funded', 'Submitted'] as const) {
    const { connection, calls } = await fixture(state, 1800);
    const tx = await buildRefundTransaction(connection, { ...config, provider: undefined }, { buyer, jobAddress });
    const refund = tx.instructions.at(-1)!;
    assert.equal(decodedInstruction(refund.data), 'refund_v2'); assert(refund.keys[3]!.pubkey.equals(mint));
    assert(refund.keys[4]!.pubkey.equals(getAssociatedTokenAddressSync(mint, buyer)));
    assert(calls.every(call => call.commitment === 'finalized')); assert.equal(calls.length, 2, 'direct account/Clock RPC reads only');
  }
  const early = await fixture('Submitted', 1799);
  await assert.rejects(buildRefundTransaction(early.connection, config, { buyer, jobAddress }), /not arrived/);
  for (const state of ['Released', 'Refunded'] as const) {
    const { connection } = await fixture(state, 1800);
    await assert.rejects(buildRefundTransaction(connection, config, { buyer, jobAddress }), /already/);
    await assert.rejects(buildApproveV2Transaction(connection, config, { buyer, jobAddress, resultHash }), /already/);
  }
});

test('provider transactions expose exact signed broadcast signature before network I/O', () => {
  const signer = Keypair.generate();
  const tx = new Transaction({ feePayer: signer.publicKey, recentBlockhash: SystemProgram.programId.toBase58() }).add(
    SystemProgram.transfer({ fromPubkey: signer.publicKey, toPubkey: buyer, lamports: 1 }),
  );
  assert.throws(() => transactionSignature(tx), /fully signed/); tx.sign(signer);
  assert.match(transactionSignature(tx), /^[1-9A-HJ-NP-Za-km-z]{80,90}$/);
  assert.equal(transactionSignature(tx), transactionSignature(Transaction.from(tx.serialize())));
  tx.instructions[0]!.data[0] ^= 1;
  assert.throws(() => transactionSignature(tx), /fully signed/);
});
