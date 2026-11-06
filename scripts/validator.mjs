import { existsSync, mkdirSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { resolve } from 'node:path';
import { root } from './keys.mjs';
import { toolEnv, capture } from './runtime.mjs';
const ledger = resolve(root, '.local/ledger');
mkdirSync(resolve(root, '.local'), { recursive: true });
if (!capture('solana-test-validator', ['--version'])) {
  console.error('solana-test-validator is missing. Run npm run setup.'); process.exitCode = 1;
} else {
  console.log(`Using persistent ledger ${ledger}. Stop with Ctrl-C. No automatic ledger reset.`);
  const child = spawn('solana-test-validator', ['--ledger', ledger, '--bind-address', '127.0.0.1', '--rpc-port', '8899'], { cwd: root, env: toolEnv(), stdio: 'inherit' });
  for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => child.kill(signal));
  child.on('error', error => { console.error(error.message); process.exitCode = 1; });
  child.on('exit', code => { process.exitCode = code || 0; });
}
