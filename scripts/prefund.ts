import { getConnection } from '@holdfast/chain';
import { clusterArg, loadConfig, loadKey, assertNetwork, ensureSol, writeEvidence } from './common.js';
const cluster = clusterArg();
const config = await loadConfig(cluster);
const connection = getConnection(config);
const deployer = await loadKey('deployer');
try {
  const genesis = await assertNetwork(connection, config);
  await ensureSol(connection, deployer.publicKey, 2, cluster);
  const lamports = await connection.getBalance(deployer.publicKey, 'finalized');
  await writeEvidence(`funding-${cluster}`, { at: new Date().toISOString(), genesis, wallet: deployer.publicKey.toBase58(), lamports, testOnly: true });
  console.log(`Disposable deployment wallet funded: ${deployer.publicKey.toBase58()} (${lamports / 1e9} test SOL)`);
} catch (error) {
  await writeEvidence(`funding-${cluster}-blocked`, { at: new Date().toISOString(), wallet: deployer.publicKey.toBase58(), error: String(error),
    action: `Use https://faucet.solana.com to fund ${deployer.publicKey.toBase58()} on Devnet; success is a positive balance in the deployment wallet.` });
  throw error;
}
