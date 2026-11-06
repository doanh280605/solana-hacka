import assert from 'node:assert/strict';
import test from 'node:test';
import { createRpcFetch } from '../src/rpc.js';

test('connections sharing an RPC origin serialize requests and release the queue after failure', async () => {
  let active = 0, maximum = 0;
  const calls: string[] = [];
  const fetcher: typeof fetch = async (_input, init) => {
    active++; maximum = Math.max(maximum, active);
    calls.push(String(init?.body));
    await new Promise(resolve => setTimeout(resolve, 5));
    active--;
    if (init?.body === 'failed') throw new Error('transport failure');
    return new Response('ok');
  };
  const first = createRpcFetch('https://serialized-rpc.invalid/a', { fetch: fetcher, intervalMs: 0 });
  const second = createRpcFetch('https://serialized-rpc.invalid/b', { fetch: fetcher, intervalMs: 0 });
  const results = await Promise.allSettled([
    first('https://serialized-rpc.invalid/a', { body: 'failed' }),
    second('https://serialized-rpc.invalid/b', { body: 'next' }),
    first('https://serialized-rpc.invalid/a', { body: 'last' }),
  ]);
  assert.equal(maximum, 1);
  assert.deepEqual(calls, ['failed', 'next', 'last']);
  assert.deepEqual(results.map(result => result.status), ['rejected', 'fulfilled', 'fulfilled']);
});

test('429 retry honors Retry-After and preserves signed transaction bytes and destination', async () => {
  const calls: { input: string; body: unknown }[] = [], delays: number[] = [];
  const body = JSON.stringify({ jsonrpc: '2.0', id: 'same-id', method: 'sendTransaction', params: ['same-signed-bytes'] });
  const paced = createRpcFetch('https://retry-rpc.invalid', {
    intervalMs: 0, retryDelaysMs: [0], pause: async ms => { delays.push(ms); },
    fetch: async (input, init) => {
      calls.push({ input: String(input), body: init?.body });
      return calls.length === 1 ? new Response('limited', { status: 429, headers: { 'Retry-After': '12' } }) : new Response('ok');
    },
  });
  assert.equal((await paced('https://retry-rpc.invalid', { method: 'POST', body })).status, 200);
  assert.deepEqual(calls, [{ input: 'https://retry-rpc.invalid', body }, { input: 'https://retry-rpc.invalid', body }]);
  assert(delays.some(ms => ms >= 11_900), 'Server cooldown was ignored.');
});

test('retries are bounded and non-rate-limit failures are returned unchanged', async () => {
  let attempts = 0;
  const limited = createRpcFetch('https://bounded-rpc.invalid', {
    intervalMs: 0, retryDelaysMs: [0, 0], pause: async () => {},
    fetch: async () => { attempts++; return new Response('limited', { status: 429 }); },
  });
  assert.equal((await limited('https://bounded-rpc.invalid')).status, 429);
  assert.equal(attempts, 3);
  attempts = 0;
  const rejected = createRpcFetch('https://rejected-rpc.invalid', {
    intervalMs: 0, fetch: async () => { attempts++; return new Response('rejected', { status: 403 }); },
  });
  assert.equal((await rejected('https://rejected-rpc.invalid')).status, 403);
  assert.equal(attempts, 1);
});

test('long server cooldowns fail promptly without oversized timers or new requests', async () => {
  let calls = 0;
  const waits: number[] = [];
  const endpoint = 'https://long-cooldown.invalid';
  const paced = createRpcFetch(endpoint, {
    intervalMs: 0, retryDelaysMs: [0], pause: async ms => { waits.push(ms); },
    fetch: async () => { calls++; return new Response('limited', { status: 429, headers: { 'Retry-After': '3600' } }); },
  });
  await assert.rejects(paced(endpoint), /cooldown exceeds/);
  await assert.rejects(paced(endpoint), /cooldown exceeds/);
  assert.equal(calls, 1, 'A request was sent before the server cooldown elapsed.');
  assert(waits.every(ms => ms <= 60_000));
});

test('overflowing cooldown headers cannot poison subsequent healthy requests', async () => {
  let calls = 0;
  const waits: number[] = [];
  const endpoint = 'https://overflow-cooldown.invalid';
  const paced = createRpcFetch(endpoint, {
    intervalMs: 0, retryDelaysMs: [0], pause: async ms => { waits.push(ms); },
    fetch: async () => {
      calls++;
      return calls === 1 ? new Response('limited', { status: 429, headers: { 'Retry-After': '1e308' } }) : new Response('ok');
    },
  });
  assert.equal((await paced(endpoint)).status, 200);
  assert.equal((await paced(endpoint)).status, 200);
  assert.equal(calls, 3);
  assert(waits.every(ms => Number.isFinite(ms) && ms <= 60_000));
});

test('invalid pacing values are rejected before any request is sent', () => {
  for (const value of [-1, Infinity, NaN, 1e20]) {
    assert.throws(() => createRpcFetch('https://invalid-pacing.invalid', { intervalMs: value }), /pacing values/);
    assert.throws(() => createRpcFetch('https://invalid-pacing.invalid', { retryDelaysMs: [value] }), /pacing values/);
  }
});
