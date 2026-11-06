import { stat } from 'node:fs/promises';
import { resolve } from 'node:path';
import { getConnection, PublicKey } from '@holdfast/chain';
import { ROOT, loadConfig, loadKey, assertNetwork, writeEvidence } from './common.js';

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
const requiredLamports = account?.executable ? 250_000_000 : rent * 2 + 250_000_000;
const report = { at: new Date().toISOString(), genesis, finalizedSlot: slot,
  programId: config.programId, executable: !!account?.executable, deployer: deployer.publicKey.toBase58(),
  deployerLamports: lamports, estimatedRequiredLamports: requiredLamports,
  fundingReady: lamports >= requiredLamports,
  nextAction: lamports >= requiredLamports ? 'Run npm run deploy:devnet, verify:devnet and rehearse:devnet.'
    : `Fund ${deployer.publicKey.toBase58()} with 5 Devnet test SOL at https://faucet.solana.com.`,
  note: 'Read-only network/funding observation; not proof of release or refund.' };
await writeEvidence('devnet-status', report);
console.log(JSON.stringify(report, null, 2));
