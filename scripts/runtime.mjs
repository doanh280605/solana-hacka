import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { root, ensureKeys } from './keys.mjs';

export const versions = Object.freeze({ node: '22.21.1', npm: '10.9.4', anchor: '0.31.1', solana: '2.1.0' });
export function toolEnv(extra = {}) {
  return {
    ...process.env,
    PATH: [resolve(root, '.tools/solana/solana-release/bin'), resolve(root, '.tools/anchor/bin'), process.env.PATH].join(':'),
    CARGO_HOME: resolve(root, '.tools/cargo'),
    npm_config_cache: resolve(root, '.local/npm-cache'),
    ...extra,
  };
}
export function run(command, args, options = {}) {
  const result = spawnSync(command, args, { cwd: root, env: toolEnv(), stdio: 'inherit', ...options });
  if (result.error) throw new Error(`${command}: ${result.error.message}`);
  if (result.status !== 0) throw new Error(`${command} ${args.join(' ')} exited ${result.status}`);
  return result;
}
export function capture(command, args) {
  const result = spawnSync(command, args, { cwd: root, env: toolEnv(), encoding: 'utf8', timeout: 15000 });
  if (result.error || result.status !== 0) return null;
  return result.stdout.trim();
}
export function syncProgramIdentity() {
  // Compiling a program requires its identity, not buyer or mint private keys.
  const addresses = ensureKeys(['program']);
  const source = resolve(root, 'programs/checkout/src/lib.rs');
  if (!existsSync(source)) throw new Error('Program source is missing.');
  const original = readFileSync(source, 'utf8');
  const replaced = original.replace(/declare_id!\("[1-9A-HJ-NP-Za-km-z]+"\)/, `declare_id!("${addresses.program}")`);
  if (!replaced.includes(`declare_id!("${addresses.program}")`)) throw new Error('Could not align program source ID.');
  if (replaced !== original) writeFileSync(source, replaced);
  const anchorPath = resolve(root, 'Anchor.toml');
  const anchor = readFileSync(anchorPath, 'utf8');
  writeFileSync(anchorPath, anchor.replace(/checkout\s*=\s*"[1-9A-HJ-NP-Za-km-z]+"/g, `checkout = "${addresses.program}"`));
  mkdirSync(resolve(root, 'target/deploy'), { recursive: true });
  const targetKey = resolve(root, 'target/deploy/checkout-keypair.json');
  const secret = readFileSync(resolve(root, '.local/keys/program.json'));
  if (existsSync(targetKey) && !Buffer.from(JSON.parse(readFileSync(targetKey, 'utf8'))).equals(Buffer.from(JSON.parse(secret)))) {
    throw new Error('Build program key differs from .local/keys/program.json. Resolve identity before building.');
  }
  writeFileSync(targetKey, secret, { mode: 0o600 });
  return addresses;
}
export function publicConfig(cluster, addresses, rpcUrl) {
  if (!['localnet', 'devnet'].includes(cluster)) throw new Error('Choose localnet or devnet.');
  return {
    rpcUrl: rpcUrl || (cluster === 'devnet' ? 'https://api.devnet.solana.com' : 'http://127.0.0.1:8899'),
    programId: addresses.program, mint: addresses.mint, merchant: addresses.merchant,
    ...(addresses.provider ? { provider: addresses.provider } : {}),
    decimals: 6, amount: '5000000', cluster,
  };
}
export function writeRuntimeConfig(config) {
  mkdirSync(resolve(root, '.local'), { recursive: true });
  writeFileSync(resolve(root, `.local/${config.cluster}.json`), JSON.stringify(config, null, 2) + '\n');
  const lines = [
    `RPC_URL=${config.rpcUrl}`, `PROGRAM_ID=${config.programId}`, `MINT=${config.mint}`,
    `MERCHANT=${config.merchant}`, `CLUSTER=${config.cluster}`, 'WORKER_PORT=8787',
    `WORKER_DATA_DIR=.local/worker-${config.cluster}`, 'ORDER_LIFETIME_SECONDS=120',
    ...(config.provider ? [`PROVIDER=${config.provider}`, 'PROVIDER_KEYPAIR_PATH=.local/keys/provider.json'] : []),
    'OSID_ORDER_LIFETIME_SECONDS=1800', 'OSID_QUOTE_LIFETIME_SECONDS=600',
    'CORS_ORIGINS=http://localhost:5173,http://localhost:4173',
  ];
  // Deployment must not erase provider credentials or custom server settings.
  const envPath = resolve(root, '.env');
  const managed = new Set(lines.map(line => line.split('=', 1)[0]));
  const retained = existsSync(envPath) ? readFileSync(envPath, 'utf8').split('\n')
    .filter(line => line.trim() && !managed.has(line.split('=', 1)[0])) : [];
  writeFileSync(envPath, [...lines, ...retained].join('\n') + '\n', { mode: 0o600 });
  writeFileSync(resolve(root, 'apps/web/.env.local'), [
    `VITE_RPC_URL=${config.rpcUrl}`, `VITE_PROGRAM_ID=${config.programId}`, `VITE_MINT=${config.mint}`,
    `VITE_MERCHANT=${config.merchant}`, `VITE_CLUSTER=${config.cluster}`, 'VITE_WORKER_URL=http://localhost:8787',
    ...(config.provider ? [`VITE_PROVIDER=${config.provider}`] : []),
  ].join('\n') + '\n');
}
