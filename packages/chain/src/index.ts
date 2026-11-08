import { BorshAccountsCoder, BorshInstructionCoder, utils, type Idl } from '@coral-xyz/anchor';
import BN from 'bn.js';
import {
  Connection, Keypair, PublicKey, Transaction, TransactionInstruction, SystemProgram,
  type AccountMeta,
} from '@solana/web3.js';
import {
  TOKEN_PROGRAM_ID, getAssociatedTokenAddressSync,
  createAssociatedTokenAccountIdempotentInstruction,
} from '@solana/spl-token';
import { Buffer } from 'buffer';
import rawIdl from '../idl/checkout.json' with { type: 'json' };
import { createRpcFetch } from './rpc.js';
import { computeTermsHash, integerSeconds, nonzeroHashBytes } from './commitments.js';

export { Connection, Keypair, PublicKey, Transaction, TransactionInstruction, TOKEN_PROGRAM_ID };
export { canonicalJson, hashCanonical, computeTermsHash, V2_SCHEMA_VERSION } from './commitments.js';
export type { TermsV2 } from './commitments.js';
export type { AccountMeta };
export const CHECKOUT_IDL = rawIdl as Idl;
export const DEMO_AMOUNT = '5000000';
export const TOKEN_DECIMALS = 6;
export interface PublicConfig {
  rpcUrl: string;
  programId: string;
  mint: string;
  merchant: string;
  provider?: string;
  decimals: 6;
  amount: string;
  cluster: 'localnet' | 'devnet';
}
export type JobState = 'Funded' | 'Submitted' | 'Released' | 'Refunded';
export interface Job {
  address: string;
  buyer: string;
  merchant: string;
  mint: string;
  jobId: string;
  amount: string;
  expiresAt: number;
  state: JobState;
  vault: string;
  version?: 1 | 2;
  provider?: string;
  inputHash?: string;
  specHash?: string;
  termsHash?: string;
  resultHash?: string;
  quoteExpiresAt?: number;
  submittedAt?: number;
}
export interface Order {
  jobId: string;
  jobAddress: string;
  buyer: string;
  merchant: string;
  mint: string;
  amount: string;
  expiresAt: number;
  mode: 'normal' | 'stall';
  status: 'quoted' | 'funded' | 'processing' | 'submitting' | 'ready' | 'released' | 'refunded' | 'failed';
  previewUrl?: string;
  error?: string;
}

const accountCoder = new BorshAccountsCoder(CHECKOUT_IDL);
const instructionCoder = new BorshInstructionCoder(CHECKOUT_IDL);
export function validateConfig(config: PublicConfig): PublicConfig {
  if (config.cluster !== 'localnet' && config.cluster !== 'devnet') throw new Error('Only localnet and Devnet are supported.');
  const url = new URL(config.rpcUrl);
  if (!['http:', 'https:'].includes(url.protocol)) throw new Error('Invalid RPC URL.');
  if (config.decimals !== 6 || config.amount !== DEMO_AMOUNT) throw new Error('Demo quote must be 5 mock USDC with six decimals.');
  for (const value of [config.programId, config.mint, config.merchant]) new PublicKey(value);
  if (config.provider !== undefined) {
    if (new PublicKey(config.provider).equals(PublicKey.default)) throw new Error('Provider must be nonzero.');
  }
  if (config.programId !== CHECKOUT_IDL.address) throw new Error('Program ID differs from checked-in IDL. Run npm run build:program.');
  return config;
}
export function getConnection(config: PublicConfig): Connection {
  validateConfig(config);
  return new Connection(config.rpcUrl, {
    commitment: 'finalized', confirmTransactionInitialTimeout: 60_000,
    fetch: createRpcFetch(config.rpcUrl), disableRetryOnRateLimit: true,
  });
}
export function jobIdBytes(jobId: string): Buffer {
  if (!/^[0-9a-f]{64}$/.test(jobId)) throw new Error('Job ID must be 64 lowercase hexadecimal characters.');
  return Buffer.from(jobId, 'hex');
}
export function deriveJobAddress(config: Pick<PublicConfig, 'programId'>, buyer: string | PublicKey, jobId: string): PublicKey {
  return PublicKey.findProgramAddressSync([
    Buffer.from('job'), new PublicKey(buyer).toBuffer(), jobIdBytes(jobId),
  ], new PublicKey(config.programId))[0];
}
export function deriveJobV2Address(config: Pick<PublicConfig, 'programId'>, buyer: string | PublicKey, jobId: string): PublicKey {
  return PublicKey.findProgramAddressSync([
    Buffer.from('job_v2'), new PublicKey(buyer).toBuffer(), jobIdBytes(jobId),
  ], new PublicKey(config.programId))[0];
}
export function deriveVaultAddress(config: Pick<PublicConfig, 'programId'>, jobAddress: string | PublicKey): PublicKey {
  return PublicKey.findProgramAddressSync([
    Buffer.from('vault'), new PublicKey(jobAddress).toBuffer(),
  ], new PublicKey(config.programId))[0];
}
export function deriveConfigAddress(config: Pick<PublicConfig, 'programId'>): PublicKey {
  return PublicKey.findProgramAddressSync([Buffer.from('config')], new PublicKey(config.programId))[0];
}
export async function fetchJob(connection: Connection, config: PublicConfig, address: string | PublicKey): Promise<Job | null> {
  const publicKey = new PublicKey(address);
  const info = await connection.getAccountInfo(publicKey, 'finalized');
  if (!info) return null;
  if (!info.owner.equals(new PublicKey(config.programId)) || info.executable) throw new Error('This account is not a checkout job.');
  const v2 = CHECKOUT_IDL.accounts!.find(account => account.name === 'JobV2');
  const isV2 = v2 && info.data.subarray(0, 8).equals(Buffer.from(v2.discriminator));
  // Fixed-size versioned accounts must not be silently reinterpreted as another layout.
  if (info.data.length !== (isV2 ? 333 : 155)) throw new Error('Invalid checkout job account size.');
  const raw = accountCoder.decode(isV2 ? 'JobV2' : 'Job', info.data);
  const buyer = raw.buyer.toBase58();
  const jobId = Buffer.from(raw.job_id).toString('hex');
  const expected = (isV2 ? deriveJobV2Address : deriveJobAddress)(config, buyer, jobId);
  if (!expected.equals(publicKey)) throw new Error('Job address does not match its buyer and ID.');
  const stateKey = Object.keys(raw.state)[0]?.toLowerCase();
  const states: Record<string, JobState> = { funded: 'Funded', ...(isV2 ? { submitted: 'Submitted' as const } : {}), released: 'Released', refunded: 'Refunded' };
  const state = stateKey ? states[stateKey] : undefined;
  if (!state) throw new Error('Unknown onchain job state.');
  const expiresAt = raw.expires_at.toNumber();
  if (!Number.isSafeInteger(expiresAt)) throw new Error('Invalid chain deadline.');
  const job: Job = {
    address: publicKey.toBase58(), buyer, merchant: raw.merchant.toBase58(), mint: raw.mint.toBase58(),
    jobId, amount: raw.amount.toString(), expiresAt, state,
    vault: deriveVaultAddress(config, publicKey).toBase58(),
    version: isV2 ? 2 : 1,
  };
  if (isV2) {
    if (raw.schema_version !== 2) throw new Error('Unsupported job schema version.');
    const quoteExpiresAt = raw.quote_expires_at.toNumber();
    const submittedAt = raw.submitted_at.toNumber();
    if (!Number.isSafeInteger(quoteExpiresAt) || !Number.isSafeInteger(submittedAt)) throw new Error('Invalid V2 chain time.');
    Object.assign(job, { provider: raw.provider.toBase58(),
      inputHash: Buffer.from(raw.input_hash).toString('hex'), specHash: Buffer.from(raw.spec_hash).toString('hex'),
      termsHash: Buffer.from(raw.terms_hash).toString('hex'), resultHash: Buffer.from(raw.result_hash).toString('hex'),
      quoteExpiresAt, submittedAt });
    const computed = await computeTermsHash({ programId: config.programId, jobAddress: job.address,
      jobId, buyer, merchant: job.merchant, provider: job.provider!, mint: job.mint,
      amount: job.amount, expiresAt, quoteExpiresAt, inputHash: job.inputHash!, specHash: job.specHash! });
    if (computed !== job.termsHash) throw new Error('Onchain terms commitment does not match recorded job fields.');
  }
  return job;
}
export async function fetchChainTime(connection: Connection): Promise<number> {
  // Read the Clock sysvar directly: unix_timestamp is an i64 at byte offset 32.
  const clock = await connection.getAccountInfo(new PublicKey('SysvarC1ock11111111111111111111111111111111'), 'finalized');
  if (!clock || clock.data.length < 40) throw new Error('Chain clock is unavailable; retry the RPC.');
  const value = Number(clock.data.readBigInt64LE(32));
  if (!Number.isSafeInteger(value) || value <= 0) throw new Error('Invalid chain clock.');
  return value;
}
export type InstructionName = 'initialize' | 'fund' | 'approve' | 'refund' | 'fund_v2' | 'submit_v2' | 'approve_v2' | 'refund_v2';
export function encodeInstruction(name: InstructionName, args: Record<string, unknown> = {}): Buffer {
  return instructionCoder.encode(name, args);
}
export function instruction(config: Pick<PublicConfig, 'programId'>, name: InstructionName, keys: AccountMeta[], args: Record<string, unknown> = {}): TransactionInstruction {
  return new TransactionInstruction({ programId: new PublicKey(config.programId), keys, data: encodeInstruction(name, args) });
}
export async function buildFundV2Transaction(connection: Connection, config: PublicConfig, input: {
  buyer: string | PublicKey; jobId: string; expiresAt: number; quoteExpiresAt: number;
  inputHash: string; specHash: string; termsHash: string; amount?: string; provider?: string | PublicKey;
}): Promise<Transaction> {
  validateConfig(config);
  if (!config.provider) throw new Error('A trusted provider is required for V2 funding.');
  const provider = new PublicKey(config.provider);
  if (input.provider && !provider.equals(new PublicKey(input.provider))) throw new Error('Quote provider does not match trusted configuration.');
  if (input.amount !== undefined && input.amount !== config.amount) throw new Error('Quote amount does not match trusted configuration.');
  integerSeconds(input.expiresAt); integerSeconds(input.quoteExpiresAt);
  const buyer = new PublicKey(input.buyer);
  const merchant = new PublicKey(config.merchant);
  const mint = new PublicKey(config.mint);
  const job = deriveJobV2Address(config, buyer, input.jobId);
  const termsHash = await computeTermsHash({ ...input, programId: config.programId, jobAddress: job,
    merchant, mint, provider, amount: config.amount });
  if (termsHash !== input.termsHash) throw new Error('Quote terms commitment does not match the agreed job fields.');
  const now = await fetchChainTime(connection);
  if (now >= input.quoteExpiresAt) throw new Error('The funding quote has expired. Request a new quote.');
  if (input.quoteExpiresAt >= input.expiresAt || input.expiresAt - now > 86_400) throw new Error('Invalid execution deadline.');
  const buyerToken = getAssociatedTokenAddressSync(mint, buyer);
  const merchantToken = getAssociatedTokenAddressSync(mint, merchant);
  return prepareTransaction(connection, buyer, [
    createAssociatedTokenAccountIdempotentInstruction(buyer, buyerToken, buyer, mint),
    createAssociatedTokenAccountIdempotentInstruction(buyer, merchantToken, merchant, mint),
    instruction(config, 'fund_v2', [
      meta(buyer, true, true), meta(merchant), meta(provider), meta(deriveConfigAddress(config)), meta(mint),
      meta(buyerToken, true), meta(merchantToken), meta(job, true), meta(deriveVaultAddress(config, job), true),
      meta(TOKEN_PROGRAM_ID), meta(SystemProgram.programId),
    ], { job_id: [...jobIdBytes(input.jobId)], amount: new BN(config.amount), expires_at: new BN(input.expiresAt),
      quote_expires_at: new BN(input.quoteExpiresAt), input_hash: [...nonzeroHashBytes(input.inputHash)],
      spec_hash: [...nonzeroHashBytes(input.specHash)], terms_hash: [...nonzeroHashBytes(input.termsHash)] }),
  ]);
}
export function meta(pubkey: string | PublicKey, isWritable = false, isSigner = false): AccountMeta {
  return { pubkey: new PublicKey(pubkey), isWritable, isSigner };
}
/** Persist this signature and the signed bytes before broadcasting; retry only those bytes. */
export function transactionSignature(transaction: Transaction): string {
  if (!transaction.signature || !transaction.verifySignatures()) throw new Error('A fully signed transaction is required.');
  return utils.bytes.bs58.encode(transaction.signature);
}
async function prepareTransaction(connection: Connection, buyer: string | PublicKey, instructions: TransactionInstruction[]): Promise<Transaction> {
  const latest = await connection.getLatestBlockhash('confirmed');
  return new Transaction({ feePayer: new PublicKey(buyer), ...latest }).add(...instructions);
}
export async function buildFundTransaction(connection: Connection, config: PublicConfig, input: {
  buyer: string | PublicKey; jobId: string; expiresAt: number;
}): Promise<Transaction> {
  validateConfig(config);
  if (!Number.isSafeInteger(input.expiresAt)) throw new Error('Expiry must be integer chain seconds.');
  const buyer = new PublicKey(input.buyer);
  const merchant = new PublicKey(config.merchant);
  const mint = new PublicKey(config.mint);
  const job = deriveJobAddress(config, buyer, input.jobId);
  const buyerToken = getAssociatedTokenAddressSync(mint, buyer);
  const merchantToken = getAssociatedTokenAddressSync(mint, merchant);
  return prepareTransaction(connection, buyer, [
    createAssociatedTokenAccountIdempotentInstruction(buyer, buyerToken, buyer, mint),
    createAssociatedTokenAccountIdempotentInstruction(buyer, merchantToken, merchant, mint),
    instruction(config, 'fund', [
      meta(buyer, true, true), meta(merchant), meta(deriveConfigAddress(config)), meta(mint),
      meta(buyerToken, true), meta(merchantToken), meta(job, true), meta(deriveVaultAddress(config, job), true),
      meta(TOKEN_PROGRAM_ID), meta(SystemProgram.programId),
    ], { job_id: [...jobIdBytes(input.jobId)], amount: new BN(config.amount), expires_at: new BN(input.expiresAt) }),
  ]);
}
async function ownJob(connection: Connection, config: PublicConfig, buyer: string | PublicKey, jobAddress: string | PublicKey): Promise<Job> {
  const job = await fetchJob(connection, config, jobAddress);
  if (!job) throw new Error('Job was not found on this network.');
  if (job.buyer !== new PublicKey(buyer).toBase58()) throw new Error('Connect the original buyer wallet.');
  if (job.state !== 'Funded' && !(job.version === 2 && job.state === 'Submitted')) throw new Error(`Job already ${job.state.toLowerCase()}.`);
  // Recovery intentionally follows the recorded mint and destinations. It does not rely on an API quote.
  return job;
}
export async function buildApproveTransaction(connection: Connection, config: PublicConfig, input: {
  buyer: string | PublicKey; jobAddress: string | PublicKey;
}): Promise<Transaction> {
  const job = await ownJob(connection, config, input.buyer, input.jobAddress);
  if (job.version === 2) throw new Error('V2 approval requires the exact result commitment; use buildApproveV2Transaction.');
  if (await fetchChainTime(connection) >= job.expiresAt) throw new Error('Approval deadline passed. Recover the deposit instead.');
  return prepareTransaction(connection, input.buyer, [instruction(config, 'approve', [
    meta(input.buyer, false, true), meta(job.address, true), meta(job.vault, true), meta(job.mint),
    meta(getAssociatedTokenAddressSync(new PublicKey(job.mint), new PublicKey(job.merchant)), true), meta(TOKEN_PROGRAM_ID),
  ])]);
}
export async function buildSubmitV2Transaction(connection: Connection, config: PublicConfig, input: {
  provider: string | PublicKey; jobAddress: string | PublicKey; resultHash: string;
}): Promise<Transaction> {
  const resultHash = nonzeroHashBytes(input.resultHash);
  const job = await fetchJob(connection, config, input.jobAddress);
  if (!job || job.version !== 2) throw new Error('V2 job was not found on this network.');
  if (job.provider !== new PublicKey(input.provider).toBase58()) throw new Error('Only the recorded provider can submit.');
  if (job.state !== 'Funded') throw new Error('The result is already submitted or the job is terminal.');
  if (await fetchChainTime(connection) >= job.expiresAt) throw new Error('Submission deadline passed. The buyer can recover the deposit.');
  return prepareTransaction(connection, input.provider, [instruction(config, 'submit_v2', [
    meta(input.provider, false, true), meta(job.address, true),
  ], { result_hash: [...resultHash] })]);
}
export async function buildApproveV2Transaction(connection: Connection, config: PublicConfig, input: {
  buyer: string | PublicKey; jobAddress: string | PublicKey; resultHash: string;
}): Promise<Transaction> {
  const resultHash = nonzeroHashBytes(input.resultHash);
  const job = await ownJob(connection, config, input.buyer, input.jobAddress);
  if (job.version !== 2) throw new Error('Use the legacy approval builder for this V1 job.');
  if (job.state !== 'Submitted') throw new Error('The provider must submit the result before approval.');
  if (job.resultHash !== input.resultHash) throw new Error('Approval result commitment differs from the submitted result.');
  if (await fetchChainTime(connection) >= job.expiresAt) throw new Error('Approval deadline passed. Recover the deposit instead.');
  return prepareTransaction(connection, input.buyer, [instruction(config, 'approve_v2', [
    meta(input.buyer, false, true), meta(job.address, true), meta(job.vault, true), meta(job.mint),
    meta(getAssociatedTokenAddressSync(new PublicKey(job.mint), new PublicKey(job.merchant)), true), meta(TOKEN_PROGRAM_ID),
  ], { result_hash: [...resultHash] })]);
}
export async function buildRefundTransaction(connection: Connection, config: PublicConfig, input: {
  buyer: string | PublicKey; jobAddress: string | PublicKey;
}): Promise<Transaction> {
  const job = await ownJob(connection, config, input.buyer, input.jobAddress);
  if (await fetchChainTime(connection) < job.expiresAt) throw new Error('The chain deadline has not arrived yet.');
  const buyer = new PublicKey(input.buyer);
  const mint = new PublicKey(job.mint);
  const buyerToken = getAssociatedTokenAddressSync(mint, buyer);
  return prepareTransaction(connection, buyer, [
    createAssociatedTokenAccountIdempotentInstruction(buyer, buyerToken, buyer, mint),
    instruction(config, job.version === 2 ? 'refund_v2' : 'refund', [
      meta(buyer, false, true), meta(job.address, true), meta(job.vault, true), meta(mint), meta(buyerToken, true), meta(TOKEN_PROGRAM_ID),
    ]),
  ]);
}
export async function confirmTransaction(connection: Connection, signature: string): Promise<void> {
  // Poll the actual signature, so confirmations never attach an unrelated latest blockhash.
  const result = await connection.confirmTransaction(signature, 'finalized');
  if (result.value.err) throw new Error(`Transaction failed: ${JSON.stringify(result.value.err)}`);
}
export function explorerUrl(config: Pick<PublicConfig, 'cluster' | 'rpcUrl'>, signature: string): string {
  const path = `https://explorer.solana.com/tx/${encodeURIComponent(signature)}`;
  return config.cluster === 'devnet' ? `${path}?cluster=devnet` : `${path}?cluster=custom&customUrl=${encodeURIComponent(config.rpcUrl)}`;
}
