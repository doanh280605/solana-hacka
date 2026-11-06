import { readFile, stat } from 'node:fs/promises';
import { resolve } from 'node:path';
import { getConnection, PublicKey } from '@holdfast/chain';
import { ROOT, loadConfig, loadKey, assertNetwork, writeEvidence } from './common.js';
import { requireBuffer } from './deploy-buffer.js';

const bufferIndex = process.argv.indexOf('--buffer');
const bufferValue = bufferIndex >= 0 ? process.argv[bufferIndex + 1] : undefined;
if (bufferIndex >= 0 && (!bufferValue || bufferValue.startsWith('--'))) throw new Error('--buffer requires the existing public buffer address.');

const config = await loadConfig('devnet');
const connection = getConnection(config);
const deployer = await loadKey('deployer');
const genesis = await assertNetwork(connection, config);
const [account, lamports, slot, binary] = await Promise.all([
  connection.getAccountInfo(new PublicKey(config.programId), 'finalized'),
  connection.getBalance(deployer.publicKey, 'finalized'),
  connection.getSlot('finalized'),
  stat(resolve(ROOT, 'target/deploy/checkout.so')),
]);
const rent = await connection.getMinimumBalanceForRentExemption(binary.size + 45);
let existingBuffer: { address: string; lamports: number; artifactMatches: boolean } | undefined;
if (!account?.executable && bufferValue) {
  const address = new PublicKey(bufferValue);
  const buffer = await connection.getAccountInfo(address, 'finalized');
  const artifact = await readFile(resolve(ROOT, 'target/deploy/checkout.so'));
  const uploaded = requireBuffer(buffer, deployer.publicKey, artifact);
  existingBuffer = { address: address.toBase58(), lamports: buffer!.lamports, artifactMatches: uploaded.equals(artifact) };
}
const requiredLamports = account?.executable ? 250_000_000 : rent * (existingBuffer ? 1 : 2) + 250_000_000;
const report = { at: new Date().toISOString(), genesis, finalizedSlot: slot,
  programId: config.programId, executable: !!account?.executable, deployer: deployer.publicKey.toBase58(),
  existingBuffer,
  deployerLamports: lamports, estimatedRequiredLamports: requiredLamports,
  fundingReady: lamports >= requiredLamports,
  nextAction: lamports >= requiredLamports
    ? existingBuffer ? `Run npx tsx scripts/deploy.ts devnet --buffer ${existingBuffer.address}, then verify:devnet and rehearse:devnet.`
      : 'Run npm run deploy:devnet, verify:devnet and rehearse:devnet.'
    : `Fund ${deployer.publicKey.toBase58()} to at least ${(requiredLamports / 1e9).toFixed(6)} Devnet test SOL at https://faucet.solana.com.`,
  note: 'Read-only network/funding observation; not proof of release or refund.' };
await writeEvidence('devnet-status', report);
console.log(JSON.stringify(report, null, 2));
