import { existsSync, mkdirSync, chmodSync } from 'node:fs';
import { resolve } from 'node:path';
import { root, ensureKeys } from './keys.mjs';
import { versions, capture, run, syncProgramIdentity, publicConfig, writeRuntimeConfig } from './runtime.mjs';

try {
  if (Number(process.versions.node.split('.')[0]) !== 22) throw new Error(`Use Node ${versions.node} (nvm use).`);
  for (const directory of ['.tools/solana', '.tools/cargo', '.local/npm-cache']) mkdirSync(resolve(root, directory), { recursive: true });
  ensureKeys();
  console.log('Installing pinned npm workspaces; first install creates package-lock.json.');
  run('npm', [existsSync(resolve(root, 'package-lock.json')) ? 'ci' : 'install']);
  const currentSolana = capture('solana', ['--version']);
  if (!currentSolana?.startsWith(`solana-cli ${versions.solana} `)) {
    const targets = { 'darwin-arm64': 'aarch64-apple-darwin', 'darwin-x64': 'x86_64-apple-darwin', 'linux-x64': 'x86_64-unknown-linux-gnu' };
    const target = targets[`${process.platform}-${process.arch}`];
    if (!target) throw new Error('Unsupported automatic Solana binary target; install Solana 2.1.0 manually and rerun.');
    const archive = resolve(root, '.tools/solana-release.tar.bz2');
    run('curl', ['--fail', '--location', '--show-error', '--retry', '2', '--connect-timeout', '20', '--output', archive,
      `https://github.com/anza-xyz/agave/releases/download/v${versions.solana}/solana-release-${target}.tar.bz2`]);
    run('tar', ['-xjf', archive, '-C', resolve(root, '.tools/solana')]);
  }
  const solanaVersion = capture('solana', ['--version']);
  if (!solanaVersion?.startsWith(`solana-cli ${versions.solana} `)) throw new Error('Solana tool installation/version check failed.');
  if (capture('anchor', ['--version']) !== `anchor-cli ${versions.anchor}`) {
    const targets = { 'darwin-arm64': 'aarch64-apple-darwin', 'darwin-x64': 'x86_64-apple-darwin', 'linux-x64': 'x86_64-unknown-linux-gnu' };
    const target = targets[`${process.platform}-${process.arch}`];
    if (!target) throw new Error('Unsupported Anchor binary target. Install Anchor 0.31.1 manually.');
    mkdirSync(resolve(root, '.tools/anchor/bin'), { recursive: true });
    const binary = resolve(root, '.tools/anchor/bin/anchor');
    run('curl', ['--fail', '--location', '--show-error', '--retry', '2', '--connect-timeout', '20', '--output', binary,
      `https://github.com/otter-sec/anchor/releases/download/v${versions.anchor}/anchor-${versions.anchor}-${target}`]);
    chmodSync(binary, 0o755);
  }
  if (capture('anchor', ['--version']) !== `anchor-cli ${versions.anchor}`) throw new Error('Anchor version check failed.');
  const addresses = syncProgramIdentity();
  writeRuntimeConfig(publicConfig('localnet', addresses));
  console.log('Setup complete. Run npm run build:program, then npm run validator in a separate terminal.');
} catch (error) {
  console.error(`Setup stopped: ${error.message}`);
  console.error('No gate passed. Restore shell network access and rerun npm run setup. Secrets stay in ignored .local/keys.');
  process.exitCode = 1;
}
