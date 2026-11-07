import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { mkdir, open, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { loadConfiguration } from '../apps/worker/src/config.js';
import { ROOT } from './common.js';
import { portUnused, until } from './osid-runtime.js';

const recordPath = resolve(ROOT, '.local/osid-preview.json');
type Record = { at: string; aiMode: string; web: { pid: number; entry: string; url: string }; worker: { pid: number; entry: string; url: string }; logs: string[]; stoppedAt?: string };
const action = process.argv[2] ?? 'start';
if (action === 'stop') {
  const record = JSON.parse(await readFile(recordPath, 'utf8')) as Record;
  for (const server of [record.worker, record.web]) {
    const inspected = spawnSync('ps', ['-p', String(server.pid), '-o', 'command='], { encoding: 'utf8' });
    if (inspected.error) throw inspected.error;
    const command = inspected.stdout.trim();
    if (inspected.status === 1 && !command && !inspected.stderr.trim()) { console.log(`PID ${server.pid} already stopped`); continue; }
    assert.equal(inspected.status, 0, `Cannot inspect PID ${server.pid}: ${inspected.stderr}`);
    assert(command, `Cannot identify PID ${server.pid}; refusing to stop it`);
    assert(command.includes(server.entry), `PID ${server.pid} no longer matches this preview; refusing to stop it`);
    process.kill(server.pid, 'SIGTERM'); console.log(`Stopped verified osid process ${server.pid}`);
  }
  record.stoppedAt = new Date().toISOString(); await writeFile(recordPath, JSON.stringify(record, null, 2) + '\n');
} else if (action === 'start') {
  process.loadEnvFile(resolve(ROOT, '.env'));
  const { config, settings } = loadConfiguration();
  const fixture = process.argv.includes('--fixture');
  if (fixture) settings.aiMode = 'fixture';
  if (settings.aiMode === 'live' && !settings.openaiApiKey) throw new Error('OPENAI_API_KEY missing. Configure it for live AI, or explicitly run preview start --fixture for development.');
  await portUnused(5173); await portUnused(8787); await mkdir(resolve(ROOT, '.local'), { recursive: true, mode: 0o700 });
  const children: { pid: number; entry: string; url: string }[] = [], logs: string[] = [];
  async function launch(name: string, args: string[], env: NodeJS.ProcessEnv, entry: string, cwd: string, url: string) {
    const path = resolve(ROOT, `.local/osid-preview-${name}.log`); logs.push(path);
    const handle = await open(path, 'a', 0o600);
    const child = spawn(process.execPath, args, { cwd, env, detached: true, stdio: ['ignore', handle.fd, handle.fd] });
    let launchError: Error | undefined;
    child.once('error', error => { launchError = error; });
    assert(child.pid); children.push({ pid: child.pid, entry, url }); child.unref(); await handle.close();
    function alive() {
      if (launchError) throw launchError;
      if (child.exitCode !== null || child.signalCode !== null) throw new Error(`${name} exited; inspect ${path}`);
      try { process.kill(child.pid!, 0); } catch { throw new Error(`${name} exited; inspect ${path}`); }
    }
    await until(`${name} preview healthy`, async () => {
      alive();
      let healthy = false;
      try { healthy = (await fetch(url, { signal: AbortSignal.timeout(1500) })).ok; } catch { /* Wait only for this owned process. */ }
      alive();
      if (healthy) return true;
      return false;
    }, 120_000);
    return children.at(-1)!;
  }
  try {
    const workerEntry = resolve(ROOT, 'apps/worker/src/index.ts');
    const worker = await launch('worker', ['--env-file=' + resolve(ROOT, '.env'), '--import', 'tsx', workerEntry], {
      ...process.env, AI_MODE: settings.aiMode, WORKER_HOST: '127.0.0.1', WORKER_PORT: '8787',
      WORKER_DATA_DIR: process.env.OSID_PREVIEW_DATA_DIR ?? resolve(ROOT, `.local/osid-preview-data-${config.cluster}`),
      WORKER_PUBLIC_ORIGIN: 'http://localhost:8787', CORS_ORIGINS: 'http://localhost:5173,http://localhost:4173',
    }, workerEntry, ROOT, 'http://localhost:8787/health');
    const webEntry = resolve(ROOT, 'node_modules/vite/bin/vite.js');
    const web = await launch('web', [webEntry, '--host', 'localhost', '--port', '5173', '--strictPort'], {
      PATH: process.env.PATH, TMPDIR: process.env.TMPDIR,
      VITE_RPC_URL: config.rpcUrl, VITE_PROGRAM_ID: config.programId, VITE_MINT: config.mint, VITE_MERCHANT: config.merchant,
      VITE_PROVIDER: config.provider, VITE_CLUSTER: config.cluster, VITE_WORKER_URL: 'http://localhost:8787',
    }, webEntry, resolve(ROOT, 'apps/web'), 'http://localhost:5173/');
    const record: Record = { at: new Date().toISOString(), aiMode: settings.aiMode ?? 'live', web, worker, logs };
    await writeFile(recordPath, JSON.stringify(record, null, 2) + '\n', { mode: 0o600 });
    console.log(`${record.aiMode} preview: http://localhost:5173/ | /demo | /app | /recover`);
    console.log(`Worker ${worker.pid}; web ${web.pid}. Stop: npx tsx scripts/preview.ts stop`);
  } catch (error) {
    for (const child of children) { try { process.kill(child.pid, 'SIGTERM'); } catch { /* Already exited. */ } }
    throw error;
  }
} else throw new Error('Usage: preview.ts start [--fixture] | stop');
