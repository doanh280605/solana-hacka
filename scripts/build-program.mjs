import { readFileSync, writeFileSync, copyFileSync, mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { root } from './keys.mjs';
import { capture, run, syncProgramIdentity, versions } from './runtime.mjs';

try {
  const addresses = syncProgramIdentity();
  if (capture('anchor', ['--version']) !== `anchor-cli ${versions.anchor}`) throw new Error('Anchor 0.31.1 is missing. Run npm run setup.');
  if (!capture('solana', ['--version'])?.startsWith(`solana-cli ${versions.solana} `)) throw new Error('Solana 2.1.0 is missing. Run npm run setup.');
  run('node', [resolve(root, 'scripts/program-tooling.mjs'), 'build']);
  const path = resolve(root, 'target/idl/checkout.json');
  const idl = JSON.parse(readFileSync(path, 'utf8'));
  if (idl.address !== addresses.program) throw new Error('Generated IDL/program key mismatch.');
  for (const name of ['initialize', 'fund', 'approve', 'refund']) {
    if (!idl.instructions.some(i => i.name === name)) throw new Error(`Generated IDL lacks ${name}.`);
  }
  copyFileSync(path, resolve(root, 'packages/chain/idl/checkout.json'));
  const sha = path => createHash('sha256').update(readFileSync(resolve(root, path))).digest('hex');
  const provenance = { builtAt: new Date().toISOString(), programId: addresses.program,
    anchor: versions.anchor, solana: versions.solana, platformTools: 'v1.56', idlSource: 'anchor idl build',
    binarySha256: sha('target/deploy/checkout.so'), sourceSha256: sha('programs/checkout/src/lib.rs'), cargoLockSha256: sha('Cargo.lock'),
  };
  mkdirSync(resolve(root, 'evidence'), { recursive: true });
  for (const path of ['.local/build.json', 'evidence/build.json']) {
    writeFileSync(resolve(root, path), JSON.stringify(provenance, null, 2) + '\n');
  }
  console.log('Program compiled; generated IDL synchronized. Run npm run typecheck before deployment.');
} catch (error) { console.error(error.message); process.exitCode = 1; }
