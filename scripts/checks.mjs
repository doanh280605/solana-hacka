import { spawn } from 'node:child_process';
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { resolve } from 'node:path';
import { root } from './keys.mjs';
import { toolEnv } from './runtime.mjs';

const checks = [];
const evidencePrefix = process.argv.includes('--osid') ? 'osid-' : '';
const startedAt = new Date().toISOString();
const directory = resolve(root, 'evidence');
await mkdir(directory, { recursive: true });
async function check(name, command, args) {
  console.log(`Checking ${name}...`);
  const start = Date.now();
  const result = await new Promise((accept, reject) => {
    const child = spawn(command, args, { cwd: root, env: toolEnv(), stdio: ['ignore', 'pipe', 'pipe'] });
    let output = '';
    child.stdout.on('data', chunk => { output += chunk; });
    child.stderr.on('data', chunk => { output += chunk; });
    child.once('error', reject);
    child.once('exit', code => accept({ code, output }));
  });
  const log = `evidence/${evidencePrefix}${name}.txt`;
  await writeFile(resolve(root, log), result.output ? result.output.trimEnd() + '\n' : '');
  checks.push({ name, command: [command, ...args], exitCode: result.code, elapsedMs: Date.now() - start, log });
  console.log(`${result.code === 0 ? 'PASS' : 'FAIL'} ${name}`);
  if (result.code !== 0) console.error(result.output.slice(-6000));
}
for (const [name, path] of [['typecheck-root', 'tsconfig.json'], ['typecheck-chain', 'packages/chain/tsconfig.json'], ['typecheck-worker', 'apps/worker/tsconfig.json'], ['typecheck-web', 'apps/web/tsconfig.json']]) {
  await check(name, process.execPath, ['node_modules/typescript/bin/tsc', '--noEmit', '-p', path]);
}
const tests = [];
for (const path of ['packages/chain/test', 'apps/worker/test', 'apps/web/test']) {
  for (const name of (await readdir(resolve(root, path))).sort()) if (name.endsWith('.test.ts')) tests.push(`${path}/${name}`);
}
await check('unit-tests', process.execPath, ['--import', 'tsx', '--test', ...tests]);
await check('rust-tests', process.execPath, ['scripts/program-tooling.mjs', 'host-tests']);
await check('web-build', 'npm', ['run', 'build', '--workspace', '@holdfast/web']);
await check('git-whitespace', 'git', ['diff', '--check']);
await check('git-staged-whitespace', 'git', ['diff', '--cached', '--check']);
const digest = async path => createHash('sha256').update(await readFile(resolve(root, path))).digest('hex');
const sourcePaths = [
  'programs/checkout/src/lib.rs', 'packages/chain/src/index.ts', 'packages/chain/src/commitments.ts', 'packages/chain/src/rpc.ts',
  'packages/chain/idl/checkout.json',
  'apps/worker/src/app.ts', 'apps/worker/src/chain.ts', 'apps/worker/src/config.ts',
  'apps/worker/src/ai.ts', 'apps/worker/src/auth.ts', 'apps/worker/src/pack.ts', 'apps/worker/src/v2-routes.ts',
  'apps/worker/src/grounding.ts',
  'apps/worker/src/v2-service.ts', 'apps/worker/src/v2-store.ts', 'apps/worker/src/v2-types.ts',
  'apps/web/src/Workspace.tsx', 'apps/web/src/Recovery.tsx', 'apps/web/src/commitments.ts', 'apps/web/src/bundle.ts',
  'apps/web/src/ledger.ts', 'apps/web/src/token-balances.ts',
  'apps/web/src/previews.ts', 'apps/web/src/bytes.ts',
  'apps/web/vite.config.ts', 'apps/web/dev-security.ts', 'apps/web/test/dev-server-security.test.ts',
  'apps/web/src/App.tsx', 'apps/web/src/api.ts', 'apps/web/src/config.ts', 'apps/web/src/session.ts', 'apps/web/src/sign-in.ts', 'apps/web/src/types.ts', 'apps/web/src/wallet.ts',
  'scripts/deploy.ts', 'scripts/deploy-buffer.ts', 'scripts/preview.ts', 'scripts/runtime.mjs', 'scripts/common.ts',
  'scripts/osid-runtime.ts', 'scripts/osid-rehearse.ts', 'scripts/osid-ui-rehearse.ts', 'scripts/osid-demo-video.ts',
  'scripts/osid-refund-rejected.ts', 'scripts/osid-wallet-auth-smoke.ts',
  'package-lock.json',
];
const sourceSha256 = Object.fromEntries(await Promise.all(sourcePaths.map(async path => [path, await digest(path)])));
const report = { startedAt, finishedAt: new Date().toISOString(), passed: checks.every(c => c.exitCode === 0), checks,
  sourceSha256,
  programSourceSha256: await digest('programs/checkout/src/lib.rs'),
  workerServiceSha256: await digest('apps/worker/src/service.ts'),
  chainClientSha256: await digest('packages/chain/src/index.ts'),
  rpcTransportSha256: await digest('packages/chain/src/rpc.ts'),
  npmLockSha256: await digest('package-lock.json'),
  note: 'These checks do not establish deployment or live token movement. Consult program TAP and per-cluster rehearsal evidence.' };
await writeFile(resolve(directory, `${evidencePrefix}checks.json`), JSON.stringify(report, null, 2) + '\n');
if (!report.passed) process.exitCode = 1;
