import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { resolve } from 'node:path';
import { root } from './keys.mjs';
import { toolEnv, capture } from './runtime.mjs';
const ledgerFlag = process.argv.indexOf('--ledger');
if (ledgerFlag >= 0 && !process.argv[ledgerFlag + 1]) throw new Error('--ledger requires a path');
const ledger = resolve(root, (ledgerFlag >= 0 ? process.argv[ledgerFlag + 1] : process.env.VALIDATOR_LEDGER) ?? '.local/ledger');
mkdirSync(resolve(root, '.local'), { recursive: true });
if (!capture('solana-test-validator', ['--version'])) {
  console.error('solana-test-validator is missing. Run npm run setup.'); process.exitCode = 1;
} else {
  console.log(`Using persistent ledger ${ledger}. Stop with Ctrl-C. No automatic ledger reset.`);
  const cloneMint = process.argv.includes('--clone-devnet-mint')
    ? JSON.parse(readFileSync(resolve(root, '.local/addresses.json'), 'utf8')).mint : undefined;
  const child = spawn('solana-test-validator', ['--ledger', ledger, '--bind-address', '127.0.0.1', '--rpc-port', '8899',
    ...(cloneMint ? ['--url', 'https://api.devnet.solana.com', '--clone', cloneMint] : [])], { cwd: root, env: toolEnv(), stdio: 'inherit' });
  for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => child.kill(signal));
  child.on('error', error => { console.error(error.message); process.exitCode = 1; });
  child.on('exit', code => { process.exitCode = code || 0; });
}
