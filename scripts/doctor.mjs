import { promises as dns } from 'node:dns';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { root } from './keys.mjs';
import { capture, versions } from './runtime.mjs';

const checks = [];
function check(name, ok, detail) { checks.push({ name, ok, detail }); console.log(`${ok ? 'PASS' : 'BLOCKED'} ${name}: ${detail}`); }
check('Node', process.versions.node === versions.node, process.version + ` (pin ${versions.node})`);
check('Rust', !!capture('rustc', ['--version']), capture('rustc', ['--version']) || 'missing');
const solana = capture('solana', ['--version']);
check('Solana', !!solana?.startsWith(`solana-cli ${versions.solana} `), solana || 'missing; npm run setup');
const anchor = capture('anchor', ['--version']);
check('Anchor', anchor === `anchor-cli ${versions.anchor}`, anchor || 'missing; npm run setup');
check('npm dependencies', existsSync(resolve(root, 'node_modules/@solana/web3.js/package.json')), 'npm ci/install required if missing');
check('npm lockfile', existsSync(resolve(root, 'package-lock.json')), 'required before claiming reproducibility');
const hosts = ['registry.npmjs.org', 'api.github.com', 'index.crates.io', 'api.devnet.solana.com'];
await Promise.all(hosts.map(async host => {
  try { const records = await dns.lookup(host, { all: true }); check(`DNS ${host}`, records.length > 0, records.map(r => r.address).join(', ')); }
  catch (error) { check(`DNS ${host}`, false, `${error.code}: ${error.message}`); }
}));
try {
  const response = await fetch(process.env.DEVNET_RPC_URL || 'https://api.devnet.solana.com', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'getGenesisHash' }), signal: AbortSignal.timeout(10000),
  });
  const value = await response.json();
  check('Devnet RPC', response.ok && value.result === 'EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG', JSON.stringify(value));
} catch (error) { check('Devnet RPC', false, error.cause?.code || error.message); }
mkdirSync(resolve(root, 'evidence'), { recursive: true });
writeFileSync(resolve(root, 'evidence/doctor.json'), JSON.stringify({ at: new Date().toISOString(), checks }, null, 2) + '\n');
if (checks.some(c => !c.ok)) process.exitCode = 1;
