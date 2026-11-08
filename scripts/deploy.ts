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
const evidencePrefix = process.argv.includes('--osid') ? 'osid-' : '';
const config = await loadConfig(cluster);
const connection = getConnection(config);
const deployer = await loadKey('deployer');
const programKey = await loadKey('program');
const mintAddress = new PublicKey(config.mint);
const addresses = JSON.parse(await readFile(resolve(ROOT, '.local/addresses.json'), 'utf8'));
const buyer = new PublicKey(addresses.buyer);
const attacker = new PublicKey(addresses.attacker);
const provider = config.provider ? new PublicKey(config.provider) : undefined;
const testBuyers = [buyer, ...(addresses.osidbuyer ? [new PublicKey(addresses.osidbuyer)] : [])];
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
  const redeploy = process.env.REDEPLOY_PROGRAM === '1' || process.argv.includes('--upgrade');
  const programDataAddress = PublicKey.findProgramAddressSync([programKey.publicKey.toBuffer()], new PublicKey('BPFLoaderUpgradeab1e11111111111111111111111'))[0];
  const existingData = existingProgram?.executable ? await connection.getAccountInfo(programDataAddress, 'finalized') : null;
  const extensionRent = existingData ? Math.max(0, programRent - existingData.lamports) : 0;
  // Bound the disposable upgrade fee reserve to the upload size. The buffer
  // rent returns after upgrade; buyer/provider test funding happens afterward.
  const upgradeFeeReserve = Math.max(25_000_000, Math.ceil(binaryFile.size / 900) * 5_000 * 8 + 1_000_000);
  const minimumSol = existingProgram?.executable
    ? (redeploy ? (resumeBuffer ? 0 : programRent) + extensionRent + upgradeFeeReserve : 25_000_000) / LAMPORTS_PER_SOL
    : (programRent * (resumeBuffer ? 1 : 2)) / LAMPORTS_PER_SOL + 0.25;
  console.log(`Deployment wallet ${deployer.publicKey.toBase58()} requires approximately ${minimumSol.toFixed(3)} test SOL.`);
  await ensureSol(connection, deployer.publicKey, minimumSol, cluster);
  let deploymentOutput = 'Existing executable deployment retained.';
  let bufferRecovery: Awaited<ReturnType<typeof resumeProgramBuffer>> | undefined;
  if (!existingProgram?.executable || redeploy) {
    if (resumeBuffer) {
      bufferRecovery = await resumeProgramBuffer({ rpcUrl: config.rpcUrl, cluster,
        address: resumeBuffer, authority: deployer, artifactPath: binaryPath, evidencePrefix });
    }
    let bufferKeypairPath: string | undefined;
    if (!resumeBuffer) {
      const { ensureKeys } = await import('./keys.mjs');
      const bufferAddress = new PublicKey(ensureKeys(['deploybuffer']).deploybuffer);
      if (await connection.getAccountInfo(bufferAddress, 'confirmed')) throw new Error(`Existing deployment buffer ${bufferAddress.toBase58()}; inspect and resume with --buffer ${bufferAddress.toBase58()} instead of allocating another buffer.`);
      bufferKeypairPath = resolve(ROOT, '.local/keys/deploybuffer.json');
    }
    deploymentOutput = await new Promise<string>((resolveResult, reject) => {
      const binary = resolve(ROOT, '.tools/solana/solana-release/bin/solana');
      const args = ['--url', config.rpcUrl, '--keypair', resolve(ROOT, '.local/keys/deployer.json'), '--output', 'json',
        // With a fully verified existing buffer, omit the program filepath.
        // Official CLI reads/verifies that buffer and sends no bulk writes.
        'program', 'deploy', ...(resumeBuffer ? ['--buffer', resumeBuffer.toBase58()] : [binaryPath, '--buffer', bufferKeypairPath!]), '--program-id', resolve(ROOT, '.local/keys/program.json'),
        '--upgrade-authority', resolve(ROOT, '.local/keys/deployer.json'), '--max-len', String(binaryFile.size), '--use-rpc'];
      const child = spawn(binary, args, { cwd: ROOT, env: process.env, stdio: ['ignore', 'pipe', 'pipe'] });
      let output = '';
      child.stdout.on('data', (chunk: Buffer) => { output += chunk.toString(); process.stdout.write(chunk); });
      child.stderr.on('data', (chunk: Buffer) => process.stderr.write(chunk));
      child.on('error', reject);
      child.on('exit', code => code === 0 ? resolveResult(output) : reject(new Error(`Solana deployment exited ${code}`)));
    });
    const deployment = JSON.parse(deploymentOutput) as { signature?: string };
    await writeEvidence(`${evidencePrefix}deployment-${cluster}-progress`, { at: new Date().toISOString(), programId: config.programId,
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
  if (!(await connection.getAccountInfo(mintAddress, 'finalized'))) {
    const mintKey = await loadKey('mint');
    if (!mintKey.publicKey.equals(mintAddress)) throw new Error('Mint key does not match configured mock mint');
    await createMint(connection, deployer, deployer.publicKey, null, 6, mintKey, { commitment: 'finalized' });
  }
  const mint = await getMint(connection, mintAddress, 'finalized');
  if (mint.decimals !== 6 || !mint.mintAuthority?.equals(deployer.publicKey) || mint.freezeAuthority) throw new Error('Unexpected mock stablecoin mint settings.');
  for (const owner of [...testBuyers, new PublicKey(config.merchant), attacker]) {
    const token = await getOrCreateAssociatedTokenAccount(connection, deployer, mintAddress, owner, false, 'finalized');
    if (testBuyers.some(key => key.equals(owner)) && token.amount < 100_000_000n) {
      await mintTo(connection, deployer, mintAddress, token.address, deployer, 100_000_000n - token.amount, [], { commitment: 'finalized' });
    }
  }
  const transfers = new Transaction();
  for (const owner of [...testBuyers, attacker, ...(provider ? [provider] : [])]) {
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
      meta(deployer.publicKey, true, true), meta(mintAddress), meta(configAddress, true),
      meta(programKey.publicKey), meta(programData), meta(SystemProgram.programId),
    ])), [deployer]);
  } else if (storedConfig) {
    const stored = await connection.getAccountInfo(configAddress, 'finalized');
    if (!stored || !stored.owner.equals(programKey.publicKey) || stored.data.length < 73
      || !stored.data.subarray(8, 40).equals(deployer.publicKey.toBuffer())
      || !stored.data.subarray(40, 72).equals(mintAddress.toBuffer())) throw new Error('Existing config differs from this deployment.');
  }
  // Generate public UI/API config only after network and deployment identity are verified.
  const { writeRuntimeConfig } = await import('./runtime.mjs');
  writeRuntimeConfig(config);
  await writeEvidence(`${evidencePrefix}deployment-${cluster}`, {
    at: new Date().toISOString(), cluster, genesis, programId: config.programId, configAddress: configAddress.toBase58(),
    mint: config.mint, mintLabel: 'Mock USDC (six decimals; test tokens only)', merchant: config.merchant, provider: config.provider,
    executable: true, binarySha256, onchainArtifactMatch: true, deploymentOutput,
    bufferRecovery,
    initialize: initializeSignature ? txEvidence(config, initializeSignature) : storedConfig ? 'Already initialized' : 'Deferred for live initializer security tests',
  });
  await rm(resolve(ROOT, `evidence/${evidencePrefix}deployment-${cluster}-blocked.json`), { force: true });
  console.log(`Deployed ${config.programId} to ${cluster}; mock mint ${config.mint}.${deferInitialize && !storedConfig ? ' Config initialization deferred for tests.' : ''}`);
} catch (error) {
  await writeEvidence(`${evidencePrefix}deployment-${cluster}-blocked`, { at: new Date().toISOString(), cluster, programId: config.programId,
    deployer: deployer.publicKey.toBase58(), error: String(error), resumeBuffer: resumeBuffer?.toBase58(),
    nextAction: resumeBuffer ? `Resume the same buffer: npx tsx scripts/deploy.ts ${cluster} --buffer ${resumeBuffer.toBase58()}`
      : `Inspect existing loader buffers before retrying. Fund the disposable deployer with test SOL if required; use --buffer PUBLIC_ADDRESS to resume without allocating another buffer.` });
  throw error;
}
