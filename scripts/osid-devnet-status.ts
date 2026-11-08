import { stat } from 'node:fs/promises';
import { resolve } from 'node:path';
import { PublicKey, getConnection } from '@holdfast/chain';
import { ROOT, assertNetwork, loadConfig, loadKey, writeEvidence } from './common.js';

const config=await loadConfig('devnet'),connection=getConnection(config),deployer=await loadKey('deployer');
const genesis=await assertNetwork(connection,config);
const binary=await stat(resolve(ROOT,'target/deploy/checkout.so'));
const programData=PublicKey.findProgramAddressSync([new PublicKey(config.programId).toBuffer()],new PublicKey('BPFLoaderUpgradeab1e11111111111111111111111'))[0];
const existing=await connection.getAccountInfo(programData,'finalized');
const rent=await connection.getMinimumBalanceForRentExemption(binary.size+45);
let balance=await connection.getBalance(deployer.publicKey,'finalized');
const feeReserve=Math.max(25_000_000,Math.ceil(binary.size/900)*5_000*8+1_000_000);
const needed=rent+Math.max(0,rent-(existing?.lamports??0))+feeReserve;
let airdrop:unknown;
if(process.argv.includes('--airdrop')&&balance<needed){
  try{const signature=await connection.requestAirdrop(deployer.publicKey,2_000_000_000);const result=await connection.confirmTransaction(signature,'finalized');
    airdrop={signature,error:result.value.err};balance=await connection.getBalance(deployer.publicKey,'finalized');
  }catch(error){airdrop={error:String(error)};}
}
const report={at:new Date().toISOString(),genesis,programId:config.programId,deployer:deployer.publicKey.toBase58(),
  binaryBytes:binary.size,deployerLamports:balance,minimumUpgradeLamports:needed,fundingReady:balance>=needed,airdrop,
  note:'Read-only upgrade rent observation plus optional explicitly requested free Devnet faucet. No deployment/paid tokens.',
  action:balance>=needed?'Run local gates before Devnet upgrade.':`Add at least ${((needed-balance)/1e9).toFixed(3)} Devnet SOL to ${deployer.publicKey.toBase58()} at https://faucet.solana.com.`};
await writeEvidence('osid-devnet-status',report);console.log(JSON.stringify(report,null,2));
