import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { atomicWrite, OrderLocks } from '../src/persistence.js';

test('atomicWrite fully replaces durable bytes with private permissions and no temporary residue', async t => {
  const root = await mkdtemp(join(tmpdir(), 'holdfast-atomic-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const path = join(root, 'private', 'order.json');
  await atomicWrite(path, Buffer.from('{"state":"quoted"}'));
  await atomicWrite(path, Buffer.from('{"state":"ready","size":123}'));
  assert.deepEqual(JSON.parse(await readFile(path, 'utf8')), { state: 'ready', size: 123 });
  assert.equal((await stat(path)).mode & 0o777, 0o600);
  assert.deepEqual(await readdir(join(root, 'private')), ['order.json']);
});

test('order mutex serializes one order, releases after failure, and permits independent orders', async () => {
  const locks = new OrderLocks();
  const events: string[] = [];
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const first = locks.run('one', async () => { events.push('first'); await gate; throw new Error('fixture failure'); });
  const rejected = assert.rejects(first, /fixture failure/);
  const second = locks.run('one', async () => { events.push('second'); });
  await locks.run('two', async () => { events.push('independent'); });
  assert.deepEqual(events, ['first', 'independent']);
  release();
  await rejected;
  await second;
  assert.deepEqual(events, ['first', 'independent', 'second']);
});
