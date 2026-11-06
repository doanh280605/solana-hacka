import { readFile, stat, rm } from 'node:fs/promises';
import { resolve } from 'node:path';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { Connection, Keypair, PublicKey, SystemProgram, Transaction, LAMPORTS_PER_SOL } from '@solana/web3.js';
import { createMint, getMint, getOrCreateAssociatedTokenAccount, mintTo } from '@solana/spl-token';
import { getConnection, deriveConfigAddress, instruction, meta } from '@holdfast/chain';
import { resumeProgramBuffer } from './deploy-buffer.js';
import {
  ROOT, clusterArg, loadConfig, loadKey, assertNetwork, send, ensureSol, writeEvidence, txEvidence,
} from './common.js';

const cluster = clusterArg();
const config = await loadConfig(cluster);
const connection = getConnection(config);
const deployer = await loadKey('deployer');
const programKey = await loadKey('program');
const mintKey = await loadKey('mint');
const buyer = await loadKey('buyer');
const attacker = await loadKey('attacker');
const bufferIndex = process.argv.indexOf('--buffer');
const bufferValue = bufferIndex >= 0 ? process.argv[bufferIndex + 1] : undefined;
if (bufferIndex >= 0 && (!bufferValue || bufferValue.startsWith('--'))) throw new Error('--buffer requires the existing public buffer address.');
const resumeBuffer = bufferValue ? new PublicKey(bufferValue) : undefined;

try {
  const genesis = await assertNetwork(connection, config);
  const binaryPath = resolve(ROOT, 'target/deploy/checkout.so');
  const binaryFile = await stat(binaryPath);
  const programRent = await connection.getMinimumBalanceForRentExemption(binaryFile.size + 45);
  const existingProgram = await connection.getAccountInfo(programKey.publicKey, 'finalized');
  const minimumSol = existingProgram?.executable ? 0.25 : (programRent * (resumeBuffer ? 1 : 2)) / LAMPORTS_PER_SOL + 0.25;
  console.log(`Deployment wallet ${deployer.publicKey.toBase58()} requires approximately ${minimumSol.toFixed(3)} test SOL.`);
  await ensureSol(connection, deployer.publicKey, minimumSol, cluster);
  let deploymentOutput = 'Existing executable deployment retained.';
  let bufferRecovery: Awaited<ReturnType<typeof resumeProgramBuffer>> | undefined;
  if (!existingProgram?.executable || process.env.REDEPLOY_PROGRAM === '1') {
    if (resumeBuffer) {
      bufferRecovery = await resumeProgramBuffer({ rpcUrl: config.rpcUrl, cluster,
        address: resumeBuffer, authority: deployer, artifactPath: binaryPath });
    }
    deploymentOutput = await new Promise<string>((resolveResult, reject) => {
      const binary = resolve(ROOT, '.tools/solana/solana-release/bin/solana');
      const args = ['--url', config.rpcUrl, '--keypair', resolve(ROOT, '.local/keys/deployer.json'), '--output', 'json',
        // With a fully verified existing buffer, omit the program filepath.
        // Official CLI reads/verifies that buffer and sends no bulk writes.
        'program', 'deploy', ...(resumeBuffer ? ['--buffer', resumeBuffer.toBase58()] : [binaryPath]), '--program-id', resolve(ROOT, '.local/keys/program.json'),
        '--upgrade-authority', resolve(ROOT, '.local/keys/deployer.json'), '--max-len', String(binaryFile.size), '--use-rpc'];
      const child = spawn(binary, args, { cwd: ROOT, env: process.env, stdio: ['ignore', 'pipe', 'pipe'] });
      let output = '';
      child.stdout.on('data', (chunk: Buffer) => { output += chunk.toString(); process.stdout.write(chunk); });
      child.stderr.on('data', (chunk: Buffer) => process.stderr.write(chunk));
      child.on('error', reject);
      child.on('exit', code => code === 0 ? resolveResult(output) : reject(new Error(`Solana deployment exited ${code}`)));
    });
    const deployment = JSON.parse(deploymentOutput) as { signature?: string };
    await writeEvidence(`deployment-${cluster}-progress`, { at: new Date().toISOString(), programId: config.programId,
      deploymentOutput, phase: 'CLI returned; awaiting finalized executable',
      transaction: deployment.signature ? txEvidence(config, deployment.signature) : null });
    if (deployment.signature) {
      const result = await connection.confirmTransaction(deployment.signature, 'finalized');
      if (result.value.err) throw new Error(`Deployment transaction failed: ${JSON.stringify(result.value.err)}`);
    }
  }
  const executable = await connection.getAccountInfo(programKey.publicKey, 'finalized');
  if (!executable?.executable) throw new Error('Program deployment is not finalized/executable.');
  const loader = new PublicKey('BPFLoaderUpgradeab1e11111111111111111111111');
  if (!executable.owner.equals(loader)) throw new Error('Expected upgradeable program loader.');
  const programData = PublicKey.findProgramAddressSync([programKey.publicKey.toBuffer()], loader)[0];
  const deployedCode = await connection.getAccountInfo(programData, 'finalized');
  const artifactBytes = await readFile(binaryPath);
  if (!deployedCode || !deployedCode.data.subarray(45, 45 + artifactBytes.length).equals(artifactBytes)) {
    throw new Error('Onchain program differs from the compiled artifact. Set REDEPLOY_PROGRAM=1 to deploy this build.');
  }
  const binarySha256 = createHash('sha256').update(artifactBytes).digest('hex');
  if (!(await connection.getAccountInfo(mintKey.publicKey, 'finalized'))) {
    await createMint(connection, deployer, deployer.publicKey, null, 6, mintKey, { commitment: 'finalized' });
  }
  const mint = await getMint(connection, mintKey.publicKey, 'finalized');
  if (mint.decimals !== 6 || !mint.mintAuthority?.equals(deployer.publicKey) || mint.freezeAuthority) throw new Error('Unexpected mock stablecoin mint settings.');
  for (const owner of [buyer.publicKey, new PublicKey(config.merchant), attacker.publicKey]) {
    const token = await getOrCreateAssociatedTokenAccount(connection, deployer, mintKey.publicKey, owner, false, 'finalized');
    if (owner.equals(buyer.publicKey) && token.amount < 100_000_000n) {
      await mintTo(connection, deployer, mintKey.publicKey, token.address, deployer, 100_000_000n - token.amount, [], { commitment: 'finalized' });
    }
  }
  const transfers = new Transaction();
  for (const owner of [buyer.publicKey, attacker.publicKey]) {
    const lamports = await connection.getBalance(owner, 'confirmed');
    if (lamports < 50_000_000) transfers.add(SystemProgram.transfer({ fromPubkey: deployer.publicKey, toPubkey: owner, lamports: 100_000_000 - lamports }));
  }
  if (transfers.instructions.length) await send(connection, transfers, [deployer]);
  const configAddress = deriveConfigAddress(config);
  let initializeSignature: string | undefined;
  const deferInitialize = process.argv.includes('--defer-initialize');
  const storedConfig = await connection.getAccountInfo(configAddress, 'finalized');
  if (!storedConfig && !deferInitialize) {
    initializeSignature = await send(connection, new Transaction().add(instruction(config, 'initialize', [
      meta(deployer.publicKey, true, true), meta(mintKey.publicKey), meta(configAddress, true),
      meta(programKey.publicKey), meta(programData), meta(SystemProgram.programId),
    ])), [deployer]);
  } else if (storedConfig) {
    const stored = await connection.getAccountInfo(configAddress, 'finalized');
    if (!stored || !stored.owner.equals(programKey.publicKey) || stored.data.length < 73
      || !stored.data.subarray(8, 40).equals(deployer.publicKey.toBuffer())
      || !stored.data.subarray(40, 72).equals(mintKey.publicKey.toBuffer())) throw new Error('Existing config differs from this deployment.');
  }
  // Generate public UI/API config only after network and deployment identity are verified.
  const { writeRuntimeConfig } = await import('./runtime.mjs');
  writeRuntimeConfig(config);
  await writeEvidence(`deployment-${cluster}`, {
    at: new Date().toISOString(), cluster, genesis, programId: config.programId, configAddress: configAddress.toBase58(),
    mint: config.mint, mintLabel: 'Mock USDC (six decimals; test tokens only)', merchant: config.merchant,
    executable: true, binarySha256, onchainArtifactMatch: true, deploymentOutput,
    bufferRecovery,
    initialize: initializeSignature ? txEvidence(config, initializeSignature) : storedConfig ? 'Already initialized' : 'Deferred for live initializer security tests',
  });
  await rm(resolve(ROOT, `evidence/deployment-${cluster}-blocked.json`), { force: true });
  console.log(`Deployed ${config.programId} to ${cluster}; mock mint ${config.mint}.${deferInitialize && !storedConfig ? ' Config initialization deferred for tests.' : ''}`);
} catch (error) {
  await writeEvidence(`deployment-${cluster}-blocked`, { at: new Date().toISOString(), cluster, programId: config.programId,
    deployer: deployer.publicKey.toBase58(), error: String(error), resumeBuffer: resumeBuffer?.toBase58(),
    nextAction: resumeBuffer ? `Resume the same buffer: npx tsx scripts/deploy.ts ${cluster} --buffer ${resumeBuffer.toBase58()}`
      : `Inspect existing loader buffers before retrying. Fund the disposable deployer with test SOL if required; use --buffer PUBLIC_ADDRESS to resume without allocating another buffer.` });
  throw error;
}
