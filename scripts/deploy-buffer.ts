import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import {
  Connection, Keypair, PublicKey, Transaction, TransactionInstruction,
  type AccountInfo,
} from '@solana/web3.js';
import { ROOT, DEVNET_GENESIS, writeEvidence } from './common.js';
import { base58 } from './keys.mjs';

export const UPGRADEABLE_LOADER = new PublicKey('BPFLoaderUpgradeab1e11111111111111111111111');
const BUFFER_METADATA_BYTES = 37;
const CHUNK_BYTES = 1000;
const WRITE_INTERVAL_MS = 900;
const BATCH_SIZE = 8;
export const LOADER_SOURCE = 'https://github.com/anza-xyz/agave/blob/v2.1.0/sdk/program/src/bpf_loader_upgradeable.rs';
export const LOADER_INSTRUCTION_SOURCE = 'https://github.com/anza-xyz/agave/blob/v2.1.0/sdk/program/src/loader_upgradeable_instruction.rs';

export function requireBuffer(account: AccountInfo<Buffer> | null, authority: PublicKey, artifact: Buffer): Buffer {
  if (!account || !account.owner.equals(UPGRADEABLE_LOADER)) throw new Error('Resume buffer must exist and belong to the upgradeable loader.');
  if (account.data.length !== BUFFER_METADATA_BYTES + artifact.length) throw new Error('Resume buffer length does not match this exact artifact.');
  if (account.data.readUInt32LE(0) !== 1 || account.data[4] !== 1
    || !account.data.subarray(5, 37).equals(authority.toBuffer())) throw new Error('Resume buffer authority does not match the disposable deployer.');
  const code = account.data.subarray(BUFFER_METADATA_BYTES);
  for (let index = 0; index < code.length; index++) {
    if (code[index] !== 0 && code[index] !== artifact[index]) throw new Error(`Resume buffer conflicts with artifact at byte ${index}; refusing to overwrite another build.`);
  }
  return code;
}

export function missingChunks(code: Buffer, artifact: Buffer): { offset: number; bytes: Buffer }[] {
  const result = [];
  let cursor = 0;
  while (cursor < artifact.length) {
    while (cursor < artifact.length && code[cursor] === artifact[cursor]) cursor++;
    if (cursor === artifact.length) break;
    const start = cursor;
    let end = Math.min(start + CHUNK_BYTES, artifact.length);
    while (end > start && code[end - 1] === artifact[end - 1]) end--;
    result.push({ offset: start, bytes: artifact.subarray(start, end) });
    cursor = end;
  }
  return result;
}

// Official v2.1.0 uses Instruction::new_with_bincode. Bincode's enum index is
// u32 LE; Write is variant 1, followed by offset:u32, length:u64 and raw bytes.
export function loaderWrite(buffer: PublicKey, authority: PublicKey, offset: number, bytes: Buffer): TransactionInstruction {
  const data = Buffer.alloc(16 + bytes.length);
  data.writeUInt32LE(1, 0);
  data.writeUInt32LE(offset, 4);
  data.writeBigUInt64LE(BigInt(bytes.length), 8);
  bytes.copy(data, 16);
  return new TransactionInstruction({ programId: UPGRADEABLE_LOADER, data, keys: [
    { pubkey: buffer, isSigner: false, isWritable: true },
    { pubkey: authority, isSigner: true, isWritable: false },
  ] });
}

export async function resumeProgramBuffer(options: {
  rpcUrl: string; cluster: 'localnet' | 'devnet'; address: PublicKey;
  authority: Keypair; artifactPath: string;
  evidencePrefix?: '' | 'osid-';
}): Promise<{ address: string; initialMissingChunks: number; initialMismatchedBytes: number; artifactSha256: string; verified: boolean; transactions: string[] }> {
  let retryAfterMs = 10_000;
  let nextRequestAt = 0;
  const connection = new Connection(options.rpcUrl, {
    commitment: 'confirmed', disableRetryOnRateLimit: true,
    fetch: async (input, init) => {
      await delay(Math.max(0, nextRequestAt - Date.now()));
      nextRequestAt = Date.now() + 400;
      const response = await fetch(input, { ...init, signal: AbortSignal.timeout(20_000) });
      const retryAfter = Number(response.headers.get('retry-after'));
      if (Number.isFinite(retryAfter) && retryAfter > 0) retryAfterMs = retryAfter * 1000;
      return response;
    },
  });
  async function rpc<T>(label: string, action: () => Promise<T>): Promise<T> {
    for (let attempt = 0; ; attempt++) {
      try { return await action(); }
      catch (error) {
        if (attempt >= 5 || !/429|50[234]|fetch failed|timeout|timed out|ECONNRESET/i.test(String(error))) throw error;
        const pause = Math.max(retryAfterMs, Math.min(30_000, 5000 * (attempt + 1)));
        console.log(`${label}: temporary RPC error; observing the same request again after ${pause / 1000}s.`);
        await delay(pause);
      }
    }
  }
  const genesis = await rpc('getGenesisHash', () => connection.getGenesisHash());
  if (options.cluster === 'devnet' && genesis !== DEVNET_GENESIS) throw new Error('Resume RPC is not Devnet.');
  if (options.cluster === 'localnet' && !['localhost', '127.0.0.1', '[::1]'].includes(new URL(options.rpcUrl).hostname)) throw new Error('Local resume requires a loopback RPC.');
  const artifact = await readFile(options.artifactPath);
  const evidencePrefix = options.evidencePrefix ?? '';
  const before = requireBuffer(await rpc('read buffer', () => connection.getAccountInfo(options.address, 'confirmed')), options.authority.publicKey, artifact);
  const chunks = missingChunks(before, artifact);
  const initialMismatchedBytes = artifact.reduce((sum, byte, index) => sum + Number(before[index] !== byte), 0);
  const artifactSha256 = createHash('sha256').update(artifact).digest('hex');
  let priorConfirmedWriteSignatures: string[] = [];
  try {
    const previous = JSON.parse(await readFile(resolve(ROOT, `evidence/${evidencePrefix}deployment-${options.cluster}-buffer.json`), 'utf8'));
    if (previous.address === options.address.toBase58() && previous.artifactSha256 === artifactSha256) {
      priorConfirmedWriteSignatures = [...new Set<string>([
        ...(previous.priorConfirmedWriteSignatures ?? []),
        ...(previous.journal ?? []).filter((item: { confirmed: boolean }) => item.confirmed).map((item: { signature: string }) => item.signature),
      ])];
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  const result = { address: options.address.toBase58(), initialMissingChunks: chunks.length,
    initialMismatchedBytes, artifactSha256,
    verified: false, transactions: [] as string[] };
  const journal: { offset: number; length: number; signature: string; confirmed: boolean }[] = [];
  async function checkpoint(phase: string) {
    const evidence = { at: new Date().toISOString(), cluster: options.cluster, genesis,
      authority: options.authority.publicKey.toBase58(), ...result, phase,
      artifactBytes: artifact.length, source: LOADER_SOURCE, instructionSource: LOADER_INSTRUCTION_SOURCE,
      sentChunks: journal.length, confirmedChunks: journal.filter(item => item.confirmed).length,
      priorConfirmedWriteSignatures,
      writeIntervalMs: WRITE_INTERVAL_MS, journal };
    await writeFile(resolve(ROOT, `.local/${evidencePrefix}deployment-${options.cluster}-buffer.json`), JSON.stringify(evidence, null, 2) + '\n');
    await writeEvidence(`${evidencePrefix}deployment-${options.cluster}-buffer`, evidence);
  }
  await checkpoint('Validated existing buffer; preparing missing writes');
  console.log(`Resuming buffer ${result.address}: ${initialMismatchedBytes} differing bytes across ${chunks.length} chunks; no new buffer allocation.`);

  let blockhash = await rpc('getLatestBlockhash', () => connection.getLatestBlockhash('confirmed'));
  let blockhashAt = Date.now();
  let lastWriteAt = 0;
  let pending: { journalIndex: number; lastValidBlockHeight: number }[] = [];
  async function confirmPending() {
    const started = Date.now();
    while (pending.length) {
      const statuses = await rpc('getSignatureStatuses', () => connection.getSignatureStatuses(pending.map(item => journal[item.journalIndex]!.signature), { searchTransactionHistory: true }));
      const stillPending = [];
      for (let index = 0; index < pending.length; index++) {
        const item = pending[index]!;
        const status = statuses.value[index];
        if (status?.err) throw new Error(`Buffer write failed at offset ${journal[item.journalIndex]!.offset}: ${JSON.stringify(status.err)}`);
        if (status && (status.confirmationStatus === 'confirmed' || status.confirmationStatus === 'finalized')) journal[item.journalIndex]!.confirmed = true;
        else stillPending.push(item);
      }
      pending = stillPending;
      if (!pending.length) break;
      if (Date.now() - started > 30_000) {
        const height = await rpc('getBlockHeight', () => connection.getBlockHeight('confirmed'));
        if (pending.some(item => height > item.lastValidBlockHeight)) {
          await checkpoint('A write blockhash expired before confirmation; rerun with this same public buffer after inspecting it');
          throw new Error(`A buffer write was not confirmed before its blockhash expired. Resume the same buffer ${result.address}; no new buffer was allocated.`);
        }
      }
      await delay(1500);
    }
    await checkpoint('Writing missing chunks');
    console.log(`Buffer writes confirmed: ${journal.filter(item => item.confirmed).length}/${chunks.length}.`);
  }

  for (const chunk of chunks) {
    // Devnet may produce slots much faster than the CLI's nominal timing.
    // Keep cached hashes short-lived rather than assuming a 60s validity.
    if (Date.now() - blockhashAt > 8_000) {
      blockhash = await rpc('getLatestBlockhash', () => connection.getLatestBlockhash('confirmed'));
      blockhashAt = Date.now();
    }
    await delay(Math.max(0, WRITE_INTERVAL_MS - (Date.now() - lastWriteAt)));
    let signature: string | undefined;
    for (let hashAttempt = 0; signature === undefined; hashAttempt++) {
      const transaction = new Transaction({ feePayer: options.authority.publicKey, ...blockhash })
        .add(loaderWrite(options.address, options.authority.publicKey, chunk.offset, chunk.bytes));
      transaction.sign(options.authority);
      const raw = transaction.serialize();
      if (raw.length > 1232) throw new Error('Loader write transaction exceeds Solana packet size.');
      // Transport retries preserve identical signed bytes. A replacement hash
      // is allowed only after the original transaction is observed or expired.
      try {
        signature = await rpc('send buffer write', () => connection.sendRawTransaction(raw, { skipPreflight: false, preflightCommitment: 'confirmed', maxRetries: 3 }));
      } catch (error) {
        if (hashAttempt >= 2 || !/Blockhash not found/i.test(String(error))) throw error;
        const originalSignature = base58(transaction.signature!);
        const original = (await rpc('observe rejected write', () => connection.getSignatureStatuses([originalSignature], { searchTransactionHistory: true }))).value[0];
        if (original?.err) throw new Error(`Original buffer write failed: ${JSON.stringify(original.err)}`);
        if (original) { signature = originalSignature; continue; }
        const height = await rpc('check rejected hash expiry', () => connection.getBlockHeight('confirmed'));
        if (height <= blockhash.lastValidBlockHeight) {
          await checkpoint('Preflight rejected an unexpired hash; no replacement was created. Re-read this buffer before resuming');
          throw new Error(`RPC rejected an unexpired blockhash; the original signature remains unobserved. Resume the same buffer ${result.address} after cooldown.`);
        }
        blockhash = await rpc('refresh expired blockhash', () => connection.getLatestBlockhash('confirmed'));
        blockhashAt = Date.now();
      }
    }
    lastWriteAt = Date.now();
    journal.push({ offset: chunk.offset, length: chunk.bytes.length, signature, confirmed: false });
    result.transactions.push(signature);
    pending.push({ journalIndex: journal.length - 1, lastValidBlockHeight: blockhash.lastValidBlockHeight });
    if (pending.length >= BATCH_SIZE) await confirmPending();
  }
  await confirmPending();
  const after = requireBuffer(await rpc('verify buffer', () => connection.getAccountInfo(options.address, 'confirmed')), options.authority.publicKey, artifact);
  if (!after.equals(artifact)) throw new Error(`Buffer ${result.address} still differs from artifact; do not finalize deployment yet.`);
  result.verified = true;
  await checkpoint('Full onchain buffer exactly matches the compiled artifact; ready for final deploy');
  console.log(`Buffer fully verified: ${artifact.length} bytes, SHA256 ${result.artifactSha256}.`);
  return result;
}
