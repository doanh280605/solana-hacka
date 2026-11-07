import { readFile, mkdir, writeFile, rename } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import {
  Connection, PublicKey, Transaction, type PublicConfig, type Job,
  fetchJob, fetchChainTime, explorerUrl,
} from '@holdfast/chain';
import { Keypair, sendAndConfirmTransaction, LAMPORTS_PER_SOL } from '@solana/web3.js';
import { getAccount, getAssociatedTokenAddressSync } from '@solana/spl-token';

export const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
export const DEVNET_GENESIS = 'EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG';
export function clusterArg(): 'localnet' | 'devnet' {
  const cluster = process.argv[2] ?? 'localnet';
  if (cluster !== 'localnet' && cluster !== 'devnet') throw new Error('Choose localnet or devnet.');
  return cluster;
}
export async function loadKey(role: string): Promise<Keypair> {
  if (!/^[a-z]+$/.test(role)) throw new Error('Invalid disposable key role.');
  return Keypair.fromSecretKey(Uint8Array.from(JSON.parse(await readFile(resolve(ROOT, `.local/keys/${role}.json`), 'utf8'))));
}
export async function loadConfig(cluster: 'localnet' | 'devnet'): Promise<PublicConfig> {
  const addresses = JSON.parse(await readFile(resolve(ROOT, '.local/addresses.json'), 'utf8'));
  return {
    rpcUrl: (cluster === 'devnet' ? process.env.DEVNET_RPC_URL : process.env.LOCAL_RPC_URL)
      || (cluster === 'devnet' ? 'https://api.devnet.solana.com' : 'http://127.0.0.1:8899'),
    programId: addresses.program, mint: addresses.mint, merchant: addresses.merchant,
    ...(addresses.provider ? { provider: addresses.provider } : {}),
    decimals: 6, amount: '5000000', cluster,
  };
}
export async function assertNetwork(connection: Connection, config: PublicConfig): Promise<string> {
  const genesis = await connection.getGenesisHash();
  if (config.cluster === 'devnet') {
    if (genesis !== DEVNET_GENESIS) throw new Error(`RPC is not Devnet: ${genesis}`);
  } else {
    const hostname = new URL(config.rpcUrl).hostname;
    if (!['localhost', '127.0.0.1', '[::1]'].includes(hostname)) throw new Error('Localnet must be a loopback RPC.');
    if (genesis === DEVNET_GENESIS || genesis === '5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp') throw new Error('Loopback RPC unexpectedly points to a public cluster.');
  }
  return genesis;
}
export async function send(connection: Connection, transaction: Transaction, signers: Keypair[]): Promise<string> {
  return sendAndConfirmTransaction(connection, transaction, signers, { commitment: 'finalized', preflightCommitment: 'confirmed' });
}
export async function balance(connection: Connection, token: PublicKey): Promise<bigint> {
  const account = await connection.getAccountInfo(token, 'finalized');
  if (!account) return 0n;
  return (await getAccount(connection, token, 'finalized')).amount;
}
export async function balances(connection: Connection, config: PublicConfig, buyer: PublicKey, vault: PublicKey): Promise<{buyer: string; merchant: string; vault: string}> {
  const mint = new PublicKey(config.mint);
  const [buyerAmount, merchantAmount, vaultAmount] = await Promise.all([
    balance(connection, getAssociatedTokenAddressSync(mint, buyer)),
    balance(connection, getAssociatedTokenAddressSync(mint, new PublicKey(config.merchant))),
    balance(connection, vault),
  ]);
  return { buyer: buyerAmount.toString(), merchant: merchantAmount.toString(), vault: vaultAmount.toString() };
}
export async function waitUntilChain(connection: Connection, epochSeconds: number, maxMs = 240_000): Promise<void> {
  const end = Date.now() + maxMs;
  while (Date.now() < end) {
    if (await fetchChainTime(connection) >= epochSeconds) return;
    await delay(1000);
  }
  throw new Error(`Timed out waiting for chain deadline ${epochSeconds}. No replacement transaction sent.`);
}
export async function requireJob(connection: Connection, config: PublicConfig, address: PublicKey | string): Promise<Job> {
  const job = await fetchJob(connection, config, address);
  if (!job) throw new Error(`Job missing: ${address.toString()}`);
  return job;
}
export async function writeEvidence(name: string, value: unknown): Promise<void> {
  if (!/^[a-z0-9-]+$/.test(name)) throw new Error('Invalid evidence name.');
  const directory = resolve(ROOT, 'evidence');
  await mkdir(directory, { recursive: true });
  const path = resolve(directory, `${name}.json`);
  const temporary = `${path}.${randomUUID()}.tmp`;
  await writeFile(temporary, JSON.stringify(value, null, 2) + '\n');
  await rename(temporary, path);
}
export function txEvidence(config: PublicConfig, signature: string) { return { signature, explorer: explorerUrl(config, signature) }; }
export async function ensureSol(connection: Connection, publicKey: PublicKey, minimumSol: number, cluster: 'localnet' | 'devnet'): Promise<void> {
  const existing = await connection.getBalance(publicKey, 'confirmed');
  if (existing >= minimumSol * LAMPORTS_PER_SOL) return;
  const wanted = cluster === 'devnet' ? Math.min(2, Math.max(1, Math.ceil(minimumSol - existing / LAMPORTS_PER_SOL))) : Math.max(10, minimumSol);
  const signature = await connection.requestAirdrop(publicKey, wanted * LAMPORTS_PER_SOL);
  const result = await connection.confirmTransaction(signature, 'confirmed');
  if (result.value.err) throw new Error(`Test SOL airdrop failed: ${JSON.stringify(result.value.err)}`);
  const final = await connection.getBalance(publicKey, 'confirmed');
  if (final < minimumSol * LAMPORTS_PER_SOL) throw new Error(`Need ${minimumSol} test SOL in ${publicKey.toBase58()}; has ${final / LAMPORTS_PER_SOL}. Use https://faucet.solana.com and rerun.`);
}
