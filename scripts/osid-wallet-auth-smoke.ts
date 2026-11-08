import assert from 'node:assert/strict';
import { generateKeyPairSync, sign } from 'node:crypto';
import { mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { PublicKey } from '@holdfast/chain';
import { chromium, type Browser } from 'playwright-core';
import { ROOT, writeEvidence } from './common.js';

// Login-only browser integration. No extension, token transaction, upload,
// quote or AI request is exercised. Private signing keys stay in Node memory.
const webOrigin = 'http://localhost:5173';
const workerOrigin = 'http://localhost:8787';
const modes = ['native', 'fallback', 'network', 'cancel', 'message', 'account', 'signature'] as const;
const cases: unknown[] = [];
const errors: string[] = [];
const report = {
  startedAt: new Date().toISOString(), passed: false, cases, errors,
  wallet: 'Disposable injected wallet; actual Phantom extension requires a human confirmation.',
  scope: 'Devnet-configured HTTP/browser login only; no orders, AI requests or token transactions.',
  privateKeysInBrowser: false,
};
let browser: Browser | undefined;
try {
  const configResponse = await fetch(`${workerOrigin}/api/config`, { signal: AbortSignal.timeout(5000) });
  assert.equal(configResponse.status, 200);
  const config = await configResponse.json() as { cluster: string; programId: string; mint: string; rpcUrl: string };
  assert.equal(config.cluster, 'devnet');
  assert.equal(config.programId, '7cW6fScgHCAWBo9YDQEhuS6brFjssJSmomRN11Xa9iKY');
  assert.equal(config.mint, '4jMjhk5ZyqnED6BtbQwiqNmcuzMJmti83nEPsceUtN7C');
  await mkdir(resolve(ROOT, 'evidence/screenshots'), { recursive: true });
  browser = await chromium.launch({ headless: true, executablePath: process.env.UI_CHROME_PATH ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' });
  for (const mode of modes) {
    console.log(`Checking wallet auth ${mode}`);
    const pair = generateKeyPairSync('ed25519');
    const bytes = pair.publicKey.export({ format: 'der', type: 'spki' }).subarray(-32);
    const address = new PublicKey(bytes).toBase58();
    const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, reducedMotion: 'reduce' });
    let signatures = 0, verifies = 0, transactionAttempts = 0;
    const transports: string[] = [];
    try {
      await context.route('**/*', async route => {
        const request = route.request(), url = new URL(request.url());
        if (['GET', 'HEAD', 'OPTIONS'].includes(request.method())) return route.continue();
        const auth = url.origin === workerOrigin && request.method() === 'POST' && ['/api/auth/nonce', '/api/auth/verify', '/api/auth/logout'].includes(url.pathname);
        let readRpc = false;
        if (request.method() === 'POST' && url.href === new URL(config.rpcUrl).href) {
          try {
            const body = request.postDataJSON();
            const calls = Array.isArray(body) ? body : [body];
            readRpc = calls.length > 0 && calls.every(call => typeof call?.method === 'string' && /^get[A-Z]/.test(call.method));
          } catch { /* All non-auth mutations fail closed below. */ }
        }
        if (auth || readRpc) return route.continue();
        errors.push(`${mode}: blocked unsupported mutation ${request.method()} ${url.pathname}`);
        return route.abort('blockedbyclient');
      });
      await context.exposeFunction('__osidAuthTransactionAttempt', () => { transactionAttempts++; });
      await context.exposeFunction('__osidAuthSign', (message: string, transport: string) => {
        const lines = message.split('\n');
        assert.equal(lines.length, 11);
        assert.equal(lines[0], 'localhost:5173 wants you to sign in with your Solana account:');
        assert.equal(lines[1], address);
        assert.equal(lines[3], 'Sign in to osid (no payment authorization)');
        assert.equal(lines[5], `URI: ${webOrigin}/app`);
        assert.equal(lines[7], 'Chain ID: solana:devnet');
        signatures++;
        transports.push(transport);
        return [...sign(null, Buffer.from(message), pair.privateKey)];
      });
      const installWallet = ({ address, publicBytes, mode }: { address: string; publicBytes: number[]; mode: typeof modes[number] }) => {
        type Stats = { native: number; fallback: number; transaction: number };
        const harness = window as unknown as { __osidAuthSign(message: string, transport: string): Promise<number[]>; __osidAuthTransactionAttempt(): Promise<void>; __osidAuthStats: Stats; phantom: unknown; solana: unknown };
        harness.__osidAuthStats = { native: 0, fallback: 0, transaction: 0 };
        const key = { toString: () => address, toBase58: () => address };
        const listeners = new Map<string, Set<(...args: unknown[]) => void>>();
        const provider = {
          publicKey: key as typeof key | null,
          async connect() { this.publicKey = key; return { publicKey: key }; },
          async disconnect() { this.publicKey = null; listeners.get('disconnect')?.forEach(fn => fn()); },
          on(event: string, fn: (...args: unknown[]) => void) { if (!listeners.has(event)) listeners.set(event, new Set()); listeners.get(event)!.add(fn); },
          removeListener(event: string, fn: (...args: unknown[]) => void) { listeners.get(event)?.delete(fn); },
          async signMessage(message: Uint8Array) {
            harness.__osidAuthStats.fallback++;
            return { signature: Uint8Array.from(await harness.__osidAuthSign(new TextDecoder().decode(message), 'fallback')) };
          },
          async signTransaction() { harness.__osidAuthStats.transaction++; await harness.__osidAuthTransactionAttempt(); throw new Error('Money actions are prohibited in login smoke.'); },
          async signAndSendTransaction() { harness.__osidAuthStats.transaction++; await harness.__osidAuthTransactionAttempt(); throw new Error('Money actions are prohibited in login smoke.'); },
        };
        if (mode !== 'fallback') Object.assign(provider, {
          async signIn(input: { domain: string; address: string; statement: string; uri: string; version: string; chainId: string; nonce: string; issuedAt: string; expirationTime: string }) {
            harness.__osidAuthStats.native++;
            if (mode === 'network') throw new Error("The app's signature request cannot be shown as the chain ID does not match the provided chain ID for verification.");
            if (mode === 'cancel') throw new Error('User rejected the request.');
            const message = [
              `${input.domain} wants you to sign in with your Solana account:`, input.address, '', input.statement, '',
              `URI: ${input.uri}`, `Version: ${input.version}`, `Chain ID: ${input.chainId}`, `Nonce: ${input.nonce}`,
              `Issued At: ${input.issuedAt}`, `Expiration Time: ${input.expirationTime}`,
            ].join('\n');
            const signature = Uint8Array.from(await harness.__osidAuthSign(message, 'native'));
            if (mode === 'signature') signature[0] ^= 1;
            return {
              account: { address: mode === 'account' ? '11111111111111111111111111111111' : address, publicKey: Uint8Array.from(publicBytes) },
              signedMessage: new TextEncoder().encode(mode === 'message' ? message.replace('solana:devnet', 'solana:mainnet') : message),
              signature, signatureType: 'ed25519',
            };
          },
        });
        harness.phantom = { solana: provider }; harness.solana = provider;
      };
      // tsx preserves function names using its __name helper. Include that helper
      // in this isolated init-script scope; Node's module scope is not a browser global.
      await context.addInitScript(`(() => { const __name = fn => fn; (${installWallet.toString()})(${JSON.stringify({ address, publicBytes: [...bytes], mode })}); })()`);
      const page = await context.newPage();
      page.on('pageerror', error => errors.push(`${mode}: ${error.message}`));
      page.on('request', request => {
        const url = new URL(request.url());
        if (url.pathname === '/api/auth/verify' && request.method() === 'POST') verifies++;
        if (url.pathname.startsWith('/api/v2/orders') && request.method() !== 'GET') errors.push(`${mode}: unexpected order mutation ${request.url()}`);
      });
      await page.goto(`${webOrigin}/app`);
      const button = page.getByRole('button', { name: 'Sign in with wallet', exact: true });
      await button.click();
      if (mode === 'native' || mode === 'fallback') {
        await page.getByRole('button', { name: 'Sign out', exact: true }).waitFor();
        const session = await page.evaluate(async ({ origin }) => {
          const response = await fetch(`${origin}/api/auth/session`, { credentials: 'include' });
          return { status: response.status, data: await response.json() };
        }, { origin: workerOrigin });
        assert.equal(session.status, 200); assert.equal(session.data.wallet, address);
        await page.reload();
        await page.getByRole('button', { name: 'Sign out', exact: true }).waitFor();
        assert.equal(signatures, 1, 'Reload must reuse the server session without another signature.');
        if (mode === 'native') {
          await page.evaluate(async () => { await document.fonts.ready; await new Promise<void>(done => requestAnimationFrame(() => requestAnimationFrame(() => done()))); });
          await page.screenshot({ path: resolve(ROOT, 'evidence/screenshots/osid-wallet-auth-desktop.png'), fullPage: true, animations: 'disabled' });
          await page.setViewportSize({ width: 390, height: 844 });
          await page.evaluate(async () => { await document.fonts.ready; await new Promise<void>(done => requestAnimationFrame(() => requestAnimationFrame(() => done()))); });
          await page.screenshot({ path: resolve(ROOT, 'evidence/screenshots/osid-wallet-auth-mobile.png'), fullPage: false, animations: 'disabled' });
          assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
        }
        await page.getByRole('button', { name: 'Sign out', exact: true }).click();
        await page.getByRole('button', { name: 'Sign in with wallet', exact: true }).waitFor();
        const loggedOut = await page.evaluate(async origin => (await fetch(`${origin}/api/auth/session`, { credentials: 'include' })).status, workerOrigin);
        assert.equal(loggedOut, 401, 'Logout must invalidate the actual server session.');
      } else {
        const expected = mode === 'network' ? /Solana Devnet/ : mode === 'cancel' ? /Wallet request declined/ : mode === 'message' ? /different sign-in message/ : mode === 'account' ? /different sign-in account/ : /signature/i;
        await page.getByRole('alert').filter({ hasText: expected }).first().waitFor();
        assert.equal(verifies, 0, 'Rejected wallet output must not reach session verification.');
        assert.equal(await page.getByRole('button', { name: 'Sign out', exact: true }).count(), 0);
      }
      assert.equal(verifies, mode === 'native' || mode === 'fallback' ? 1 : 0);
      if (mode === 'native' || mode === 'fallback') assert.deepEqual(transports, [mode]);
      // Reload installs a fresh harness, so count transport callbacks via signatures
      // for successful cases and inspect the live counters for rejection cases.
      const stats = await page.evaluate(() => (window as unknown as { __osidAuthStats: { native: number; fallback: number; transaction: number } }).__osidAuthStats);
      assert.equal(stats.transaction, 0);
      assert.equal(transactionAttempts, 0, 'Transaction attempts remain visible across reload.');
      if (mode !== 'native' && mode !== 'fallback') { assert.equal(stats.native, 1); assert.equal(stats.fallback, 0); }
      cases.push({ mode, passed: true, verifies, signatures, transports, noTransactions: true, ...(mode === 'native' || mode === 'fallback' ? { sessionRestoredAfterReload: true } : { noFallback: true }) });
      console.log(`PASS wallet auth ${mode}`);
    } finally { await context.close(); }
  }
  assert.deepEqual(errors, []);
  report.passed = true;
} catch (error) {
  errors.push(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
} finally {
  try { await browser?.close(); }
  catch (error) { report.passed = false; errors.push(`Browser cleanup: ${String(error)}`); process.exitCode = 1; }
  await writeEvidence('osid-wallet-auth', { ...report, finishedAt: new Date().toISOString() });
  console.log(JSON.stringify({ passed: report.passed, cases: cases.length, errors }));
}
