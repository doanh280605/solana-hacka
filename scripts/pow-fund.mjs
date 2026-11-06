import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  Connection, Keypair, PublicKey, SystemProgram, Transaction,
  TransactionInstruction, VersionedTransaction,
} from '@solana/web3.js';
import { root } from './keys.mjs';

// Read-only feasibility check of the faucet linked by the Solana Cookbook.
// It never reads wallet secrets, sends transactions, or changes CLI defaults.
const RPC = 'https://api.devnet.solana.com';
const GENESIS = 'EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG';
const RECIPIENT = new PublicKey(JSON.parse(readFileSync(resolve(root, '.local/addresses.json'), 'utf8')).deployer);
const PROGRAM = new PublicKey('PoWSNH2hEZogtCg1Zgm51FnkmJperzYDgPK4fvs8taL');
const COMMIT = '1efbcbf87497ed6d75a9bda373766ab11c5b4501';
const source = `https://github.com/jarry-xiao/proof-of-work-faucet/tree/${COMMIT}`;
const folder = resolve(root, '.local/funding');
mkdirSync(folder, { recursive: true });
const evidence = {
  observedAt: new Date().toISOString(), rpc: RPC, expectedGenesis: GENESIS,
  recipient: RECIPIENT.toBase58(), program: PROGRAM.toBase58(),
  officialGuide: 'https://solana.com/developers/cookbook/development/airdrops-and-faucets',
  officialFaucet: 'https://faucet.solana.com',
  source, commit: COMMIT, cliVersion: '0.1.4',
  targetLamports: 5_000_000_000,
  installed: false, miningStarted: false,
  bootstrapSourceFinding: 'CLI requests 1 SOL through requestAirdrop when payer balance is below 5000 lamports and aborts if it fails. The claim transaction has two signers. The program transfers its reward before creating a zero-data receipt; receipt rent can come from that reward, but transaction fees must exist upfront.',
};

try {
  const connection = new Connection(RPC, {
    commitment: 'confirmed', disableRetryOnRateLimit: true,
    fetch: (input, options) => fetch(input, { ...options, signal: AbortSignal.timeout(15_000) }),
  });
  evidence.genesis = await connection.getGenesisHash();
  assert.equal(evidence.genesis, GENESIS, 'Refuse any cluster other than verified Devnet');
  evidence.recipientLamports = await connection.getBalance(RECIPIENT, 'confirmed');
  const program = await connection.getAccountInfo(PROGRAM, 'confirmed');
  evidence.programExecutable = program?.executable ?? false;
  assert(program?.executable, 'The officially referenced PoW program is not executable on Devnet');
  const discriminator = createHash('sha256').update('account:Difficulty').digest().subarray(0, 8);
  const specs = await connection.getProgramAccounts(PROGRAM, {
    commitment: 'confirmed', filters: [{ dataSize: 17 }],
  });
  const verified = [];
  for (const { pubkey, account } of specs) {
    if (!account.owner.equals(PROGRAM) || !account.data.subarray(0, 8).equals(discriminator)) continue;
    const difficulty = account.data[8];
    const amountBytes = account.data.subarray(9, 17);
    const rewardLamports = account.data.readBigUInt64LE(9);
    const [expected] = PublicKey.findProgramAddressSync([Buffer.from('spec'), Buffer.from([difficulty]), amountBytes], PROGRAM);
    if (!expected.equals(pubkey)) continue;
    const [faucet] = PublicKey.findProgramAddressSync([Buffer.from('source'), pubkey.toBuffer()], PROGRAM);
    verified.push({ spec: pubkey, faucet, difficulty, rewardLamports });
  }
  const sources = [];
  for (let offset = 0; offset < verified.length; offset += 100) {
    sources.push(...await connection.getMultipleAccountsInfo(verified.slice(offset, offset + 100).map(v => v.faucet), 'confirmed'));
  }
  evidence.receiptRentLamports = await connection.getMinimumBalanceForRentExemption(0, 'confirmed');
  evidence.faucets = verified.map((item, index) => ({
    spec: item.spec.toBase58(), faucet: item.faucet.toBase58(), difficulty: item.difficulty,
    rewardLamports: item.rewardLamports.toString(), balanceLamports: sources[index]?.lamports ?? 0,
    systemOwned: sources[index]?.owner.equals(SystemProgram.programId) ?? false,
    funded: (sources[index]?.lamports ?? 0) >= item.rewardLamports,
  })).sort((a, b) => a.difficulty - b.difficulty || Number(BigInt(b.rewardLamports) - BigInt(a.rewardLamports)));
  // Fee estimation and the empty-wallet simulation do not require a solvent
  // faucet or a mined proof. Label that distinction explicitly in the evidence.
  const candidate = verified.find(v => v.rewardLamports > BigInt(evidence.receiptRentLamports + 10_000));
  if (candidate) {
    evidence.feeEstimateFaucet = candidate.faucet.toBase58();
    evidence.feeEstimateFaucetFunded = evidence.faucets.find(f => f.faucet === candidate.faucet.toBase58()).funded;
    const proofPublicKey = Keypair.generate().publicKey;
    const [receipt] = PublicKey.findProgramAddressSync([Buffer.from('receipt'), proofPublicKey.toBuffer(), Buffer.from([candidate.difficulty])], PROGRAM);
    const transaction = new Transaction({ feePayer: RECIPIENT, recentBlockhash: (await connection.getLatestBlockhash('confirmed')).blockhash });
    transaction.add(new TransactionInstruction({
      programId: PROGRAM,
      data: createHash('sha256').update('global:airdrop').digest().subarray(0, 8),
      keys: [
        { pubkey: RECIPIENT, isSigner: true, isWritable: true },
        { pubkey: proofPublicKey, isSigner: true, isWritable: false },
        { pubkey: receipt, isSigner: false, isWritable: true },
        { pubkey: candidate.spec, isSigner: false, isWritable: false },
        { pubkey: candidate.faucet, isSigner: false, isWritable: true },
        { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
      ],
    }));
    const message = transaction.compileMessage();
    evidence.claimFeeLamports = (await connection.getFeeForMessage(message, 'confirmed')).value;
    assert(Number.isSafeInteger(evidence.claimFeeLamports) && evidence.claimFeeLamports > 0, 'RPC did not return a usable claim fee');
    evidence.claimSignatures = message.header.numRequiredSignatures;
    // An unsigned, non-mined proof is sufficient to establish that the empty
    // fee payer is rejected before the faucet program is ever invoked.
    const simulation = await connection.simulateTransaction(new VersionedTransaction(message), {
      sigVerify: false, replaceRecentBlockhash: true, commitment: 'confirmed',
    });
    evidence.bootstrapSimulation = {
      proofMined: false, signaturesVerified: false,
      error: simulation.value.err, logs: simulation.value.logs,
      unitsConsumed: simulation.value.unitsConsumed,
    };
    evidence.bootstrapBlocked = evidence.recipientLamports < evidence.claimFeeLamports;
  }
  const claimCost = evidence.receiptRentLamports + (evidence.claimFeeLamports ?? 10_000);
  for (const f of evidence.faucets) {
    const actualPayout = f.systemOwned ? (BigInt(f.rewardLamports) < BigInt(f.balanceLamports) ? BigInt(f.rewardLamports) : BigInt(f.balanceLamports)) : 0n;
    f.effectivePayoutLamports = actualPayout.toString();
    f.netAfterReceiptAndFeeLamports = (actualPayout - BigInt(claimCost)).toString();
    f.cliEligible = f.systemOwned && f.funded && BigInt(f.rewardLamports) >= 895_880n && actualPayout > BigInt(claimCost);
  }
  evidence.viableFaucetCount = evidence.faucets.filter(f => f.cliEligible).length;
  evidence.viableDefinition = 'Funded for the full advertised reward, system-owned source, CLI profitability filter satisfied, reward exceeds actual receipt rent plus claim fee';
  evidence.partialRewardFaucets = evidence.faucets.filter(f => !f.funded && BigInt(f.netAfterReceiptAndFeeLamports) > 0n);
  evidence.maximumOneTimeNetFromPartialPoolsLamports = evidence.partialRewardFaucets.reduce((sum, f) => sum + BigInt(f.netAfterReceiptAndFeeLamports), 0n).toString();
  evidence.blockers = [];
  if (evidence.bootstrapBlocked) evidence.blockers.push('Recipient lacks the upfront claim fee. The official CLI falls back to public requestAirdrop, which was unavailable at the recorded deployment attempt.');
  if (evidence.viableFaucetCount === 0) evidence.blockers.push('No live faucet satisfies the official CLI full-reward solvency and profitability checks.');
  if (evidence.partialRewardFaucets.length && BigInt(evidence.maximumOneTimeNetFromPartialPoolsLamports) < BigInt(evidence.targetLamports)) evidence.blockers.push('The onchain program permits partial payouts that the official CLI skips; their combined possible net payout is below the deployment target.');
  evidence.status = evidence.blockers.length ? 'funding blockers detected; see balances and blockers; no mining or install attempted' : 'inspection complete; no mining or install attempted';
} catch (error) {
  evidence.status = 'inspection failed';
  evidence.error = error.message;
  process.exitCode = 1;
} finally {
  writeFileSync(resolve(folder, 'pow-feasibility.json'), `${JSON.stringify(evidence, null, 2)}\n`);
  mkdirSync(resolve(root, 'evidence'), { recursive: true });
  writeFileSync(resolve(root, 'evidence/funding-pow.json'), `${JSON.stringify(evidence, null, 2)}\n`);
  console.log(JSON.stringify({
    evidence: 'evidence/funding-pow.json', observedAt: evidence.observedAt,
    genesis: evidence.genesis, recipient: evidence.recipient,
    recipientLamports: evidence.recipientLamports,
    viableFaucetCount: evidence.viableFaucetCount,
    claimFeeLamports: evidence.claimFeeLamports,
    receiptRentLamports: evidence.receiptRentLamports,
    bootstrapSimulation: evidence.bootstrapSimulation,
    maximumOneTimeNetFromPartialPoolsLamports: evidence.maximumOneTimeNetFromPartialPoolsLamports,
    status: evidence.status, error: evidence.error,
  }, null, 2));
}
