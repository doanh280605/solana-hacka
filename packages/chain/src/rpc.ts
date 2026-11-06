type Fetch = typeof globalThis.fetch;
type Lane = { tail: Promise<void>; nextStart: number };
const lanes = new Map<string, Lane>();
const sleep = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));
const REQUEST_BUDGET_MS = 60_000;

// Share one request lane across connections in the same process or browser page.
// Only the public Devnet endpoint needs conservative default pacing.
export function createRpcFetch(endpoint: string, options: {
  fetch?: Fetch; intervalMs?: number; retryDelaysMs?: readonly number[];
  pause?: (ms: number) => Promise<void>;
} = {}): Fetch {
  const url = new URL(endpoint);
  const interval = options.intervalMs ?? (url.hostname === 'api.devnet.solana.com' ? 750 : 0);
  const fetcher = options.fetch ?? globalThis.fetch.bind(globalThis);
  const pause = options.pause ?? sleep;
  const retryDelays = options.retryDelaysMs ?? [10_000, 20_000, 30_000];
  for (const value of [interval, ...retryDelays]) {
    if (!Number.isSafeInteger(value) || value < 0 || value > REQUEST_BUDGET_MS) throw new Error('RPC pacing values must be between 0 and 60000 milliseconds.');
  }
  let lane = lanes.get(url.origin);
  if (!lane) { lane = { tail: Promise.resolve(), nextStart: 0 }; lanes.set(url.origin, lane); }
  const queue = lane;

  return (input, init) => {
    const deadline = Date.now() + REQUEST_BUDGET_MS;
    const pending = queue.tail.then(async () => {
      for (let attempt = 0; ; attempt++) {
        const wait = Math.max(0, queue.nextStart - Date.now());
        if (wait > deadline - Date.now() || Date.now() >= deadline) throw new Error('RPC cooldown exceeds the request time budget; retry later.');
        await pause(wait);
        queue.nextStart = Date.now() + interval;
        const timeout = AbortSignal.timeout(Math.max(1, Math.min(15_000, deadline - Date.now())));
        const signal = init?.signal ? AbortSignal.any([init.signal, timeout]) : timeout;
        const response = await fetcher(input, { ...init, signal });
        if (response.status !== 429) return response;
        const header = response.headers.get('retry-after');
        const seconds = header === null ? NaN : Number(header);
        const retryAfter = Number.isFinite(seconds) ? Math.max(0, seconds * 1000)
          : header ? Math.max(0, Date.parse(header) - Date.now()) : NaN;
        const usableRetryAfter = Number.isSafeInteger(retryAfter) && retryAfter >= 0
          && retryAfter <= Number.MAX_SAFE_INTEGER - Date.now() ? retryAfter : 0;
        const backoff = Math.max(retryDelays[attempt] ?? 10_000, usableRetryAfter);
        queue.nextStart = Math.max(queue.nextStart, Date.now() + backoff);
        if (attempt >= retryDelays.length) return response;
        // Drain the rejected response for connection reuse. Retrying preserves
        // the exact RPC body, including a transaction's existing signature.
        await response.arrayBuffer().catch(() => {});
      }
    });
    queue.tail = pending.then(() => {}, () => {});
    return pending;
  };
}
