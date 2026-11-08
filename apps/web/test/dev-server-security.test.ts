import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { request as httpRequest } from 'node:http';
import { createServer as createTcpServer } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, resolve } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const webRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const repository = resolve(webRoot, '../..');

function get(port: number, path: string): Promise<{ status: number; body: string }> {
  return new Promise((accept, reject) => {
    const request = httpRequest({ hostname: '127.0.0.1', port, path, method: 'GET' }, (response) => {
      const chunks: Buffer[] = [];
      response.on('data', (chunk) => chunks.push(chunk));
      response.on('end', () => accept({ status: response.statusCode!, body: Buffer.concat(chunks).toString() }));
      response.on('error', reject);
    });
    request.setTimeout(15_000, () => request.destroy(new Error('Dev-server security request timed out')));
    request.on('error', reject); request.end();
  });
}

test('live Vite denies private files, raw imports, traversal and public symlink aliases while serving browser imports', { timeout: 30_000 }, async (context) => {
  // These are newly created harmless markers. No real key, environment file or private input is read.
  const id = randomUUID();
  const marker = `harmless-osid-canary-${id}`;
  const local = resolve(repository, '.local', `osid-vite-security-${id}`);
  const tools = resolve(repository, '.tools', `osid-vite-security-${id}`);
  const fixture = await mkdtemp(resolve(webRoot, '.osid-vite-security-'));
  const outside = await mkdtemp(resolve(tmpdir(), 'osid-vite-private-'));
  const envCanary = resolve(webRoot, `.env.osid-canary-${id}`);
  const publicCanary = resolve(webRoot, 'public', `.env.osid-canary-${id}`);
  const publicAlias = resolve(webRoot, 'public', `osid-safe-alias-${id}.txt`);
  const localCanary = resolve(local, 'buyer.json');
  const canaries = [localCanary, resolve(tools, 'input.json'), resolve(fixture, 'provider-keypair.json'), resolve(fixture, 'private-key.json'), resolve(fixture, 'tls.pem'), resolve(fixture, '.npmrc'), resolve(fixture, 'target', 'program.so'), resolve(outside, 'arbitrary.txt'), envCanary, publicCanary];
  let ownedServer: ReturnType<typeof spawn> | undefined;
  let exited: Promise<void> = Promise.resolve();
  const reservation = createTcpServer();
  context.after(async () => {
    try {
      if (reservation.listening) await new Promise<void>(accept => reservation.close(() => accept()));
      const child = ownedServer;
      if (child && child.exitCode === null && child.signalCode === null) {
        child.kill('SIGTERM');
        const graceful = await Promise.race([exited.then(() => true), new Promise<false>(accept => { const timeout = setTimeout(() => accept(false), 2000); timeout.unref(); })]);
        if (!graceful) { child.kill('SIGKILL'); await exited; }
      }
    } finally { await Promise.all([local, tools, fixture, outside, envCanary, publicCanary, publicAlias].map((path) => rm(path, { recursive: true, force: true }))); }
  });
  for (const file of canaries) { await mkdir(dirname(file), { recursive: true }); await writeFile(file, marker, { mode: 0o600 }); }
  await symlink(localCanary, publicAlias);
  await new Promise<void>((accept, reject) => { reservation.once('error', reject); reservation.listen(0, '127.0.0.1', () => accept()); });
  const address = reservation.address(); assert(address && typeof address !== 'string');
  await new Promise<void>((accept, reject) => reservation.close((error) => error ? reject(error) : accept()));
  const server = spawn(process.execPath, [resolve(repository, 'node_modules/vite/bin/vite.js'), '--host', '127.0.0.1', '--port', String(address.port), '--strictPort'], {
    cwd: webRoot, env: { ...process.env, CI: 'true' }, stdio: ['ignore', 'pipe', 'pipe'],
  });
  ownedServer = server;
  let spawnFailure: Error | undefined;
  server.once('error', error => { spawnFailure = error; });
  // Consume output without printing response bodies, environment values or sensitive paths.
  server.stdout!.resume(); server.stderr!.resume();
  exited = new Promise<void>(accept => { server.once('exit', () => accept()); server.once('error', () => accept()); });
  let ready = false;
  for (let attempt = 0; attempt < 100; attempt++) {
    if (spawnFailure) throw spawnFailure;
    if (server.exitCode !== null || server.signalCode !== null) throw new Error('Isolated Vite process exited before becoming ready');
    try { ready = (await get(address.port, '/')).status === 200; } catch { /* listen not ready yet */ }
    if (ready) break;
    await new Promise(accept => setTimeout(accept, 50));
  }
  assert(ready, 'isolated Vite server must become ready');
  for (const file of canaries) {
    for (const suffix of ['', '?raw', '?url']) {
      const result = await get(address.port, `/@fs${file}${suffix}`);
      assert.equal(result.status, 403, 'private canary must be forbidden');
      assert.equal(result.body.includes(marker), false, 'private canary bytes must never be returned');
    }
  }
  const localSuffix = `.local/osid-vite-security-${id}/buyer.json`;
  const traversals = [
    `/@fs${webRoot}/../../${localSuffix}`,
    `/@fs${webRoot}/%2e%2e/%2e%2e/${localSuffix}`,
    `/@fs${webRoot}/%2e%2e%2f%2e%2e%2f${localSuffix}?raw`,
    `/@fs/${localCanary}`,
    `/.env.osid-canary-${id}`,
    `/public/.env.osid-canary-${id}`,
    `/osid-safe-alias-${id}.txt`,
  ];
  for (const path of traversals) {
    const result = await get(address.port, path);
    assert.equal(result.status, 403, 'normalized traversal or public alias must be forbidden');
    assert.equal(result.body.includes(marker), false, 'normalized private canary bytes must never be returned');
  }
  for (const path of ['/', '/src/main.tsx', '/src/App.tsx', '/src/Workspace.tsx', `/@fs${resolve(repository, 'packages/chain/src/index.ts')}`, `/@fs${resolve(repository, 'node_modules/buffer/index.js')}`, '/sample-before.webp']) {
    const result = await get(address.port, path);
    assert.equal(result.status, 200, 'required browser source/dependency/sample must remain available');
  }
});
