import { getConnection, PublicKey, Transaction } from '@holdfast/chain';
import { getOrCreateAssociatedTokenAccount, mintTo } from '@solana/spl-token';
import { SystemProgram } from '@solana/web3.js';
import { clusterArg, loadConfig, loadKey, assertNetwork, send } from './common.js';

const cluster = clusterArg();
const config = await loadConfig(cluster);
const connection = getConnection(config);
await assertNetwork(connection, config);
const buyer = new PublicKey(process.argv[3] ?? (await loadKey('buyer')).publicKey);
const deployer = await loadKey('deployer');
const ata = await getOrCreateAssociatedTokenAccount(connection, deployer, new PublicKey(config.mint), buyer, false, 'finalized');
await mintTo(connection, deployer, new PublicKey(config.mint), ata.address, deployer, 100_000_000n, [], { commitment: 'finalized' });
if (await connection.getBalance(buyer, 'confirmed') < 20_000_000) {
  await send(connection, new Transaction().add(SystemProgram.transfer({ fromPubkey: deployer.publicKey, toPubkey: buyer, lamports: 50_000_000 })), [deployer]);
}
console.log(`Funded ${buyer.toBase58()} with 100 mock USDC and enough test SOL for checkout.`);
