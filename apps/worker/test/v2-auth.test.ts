import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'node:test';
import { createWorker } from '../src/app.js';
import { signature } from './helpers.js';
import { login, ORIGIN, quote, v2Fixture } from './v2-helpers.js';

test('wallet sign-in binds origin, purpose, wallet, nonce and expiry; valid signatures are single use across restart', async t => {
  const f = await v2Fixture(); t.after(() => f.cleanup());
  const issue = await f.app.inject({ method: 'POST', url: '/api/auth/nonce', headers: { origin: ORIGIN }, payload: { wallet: f.buyer.address } });
  assert.equal(issue.statusCode, 200);
  const challenge = issue.json<{ nonce: string; message: string; expiresAt: number }>();
  assert.match(challenge.message, /localhost:5173 wants you to sign in/);
  for (const part of [f.buyer.address, 'Sign in to osid (no payment authorization)', `URI: ${ORIGIN}/app`, 'Chain ID: localnet', challenge.nonce, 'Issued At:', 'Expiration Time:']) assert.ok(challenge.message.includes(part));
  const payload = { wallet: f.buyer.address, nonce: challenge.nonce, signature: signature(f.buyer, challenge.message) };
  assert.equal((await f.app.inject({ method: 'POST', url: '/api/auth/verify', headers: { origin: 'https://evil.example' }, payload })).statusCode, 403);
  assert.equal((await f.app.inject({ method: 'POST', url: '/api/auth/verify', headers: { origin: ORIGIN }, payload: { ...payload, signature: signature(f.other, challenge.message) } })).statusCode, 403);
  const verified = await f.app.inject({ method: 'POST', url: '/api/auth/verify', headers: { origin: ORIGIN }, payload });
  assert.equal(verified.statusCode, 200); assert.equal(verified.json().wallet, f.buyer.address);
  assert.match(String(verified.headers['set-cookie']), /HttpOnly; SameSite=Lax; Max-Age=3600/);
  const state = JSON.parse(await readFile(join(f.settings.dataDir, 'authentication.json'), 'utf8'));
  assert.equal(state.nonces[0].used, true);
  assert.ok(!JSON.stringify(state).includes(String(verified.headers['set-cookie']).split(';')[0]!.split('=')[1]!));
  assert.equal((await f.app.inject({ method: 'POST', url: '/api/auth/verify', headers: { origin: ORIGIN }, payload })).statusCode, 401);
  await f.app.close();
  const restarted = await createWorker({ chain: f.chain, settings: f.settings, logger: false, ai: f.ai }); t.after(() => restarted.app.close());
  assert.equal((await restarted.app.inject({ method: 'POST', url: '/api/auth/verify', headers: { origin: ORIGIN }, payload })).statusCode, 401);
  const cookie = String(verified.headers['set-cookie']).split(';')[0]!;
  const session = await restarted.app.inject({ method: 'GET', url: '/api/auth/session', headers: { cookie, origin: ORIGIN } });
  assert.equal(session.statusCode, 200); assert.equal(session.json().csrfToken, verified.json().csrfToken);
});

test('session origin/CSRF and exact buyer ownership protect quotes, history, details and previews; logout revokes the cookie', async t => {
  const f = await v2Fixture(); t.after(() => f.cleanup());
  assert.equal((await f.app.inject({ method: 'GET', url: '/api/v2/orders' })).statusCode, 401);
  const auth = await login(f, f.buyer); const other = await login(f, f.other);
  const order = await quote(f, auth);
  const url = `/api/v2/orders/${order.jobId}`;
  assert.equal((await f.app.inject({ method: 'GET', url, headers: other.headers })).statusCode, 403);
  assert.equal((await f.app.inject({ method: 'GET', url: `${url}/preview/hero`, headers: other.headers })).statusCode, 403);
  assert.deepEqual((await f.app.inject({ method: 'GET', url: '/api/v2/orders', headers: other.headers })).json(), { orders: [] });
  assert.equal((await f.app.inject({ method: 'POST', url: `${url}/funded`, headers: { cookie: auth.cookie, origin: ORIGIN }, payload: {} })).statusCode, 403);
  assert.equal((await f.app.inject({ method: 'POST', url: `${url}/funded`, headers: { ...auth.headers, origin: 'https://evil.example' }, payload: {} })).statusCode, 403);
  assert.equal((await f.app.inject({ method: 'GET', url: '/api/auth/session', headers: { ...auth.headers, origin: 'https://evil.example' } })).statusCode, 403);
  const logout = await f.app.inject({ method: 'POST', url: '/api/auth/logout', headers: auth.headers, payload: {} });
  assert.equal(logout.statusCode, 200); assert.match(String(logout.headers['set-cookie']), /Max-Age=0/);
  assert.equal((await f.app.inject({ method: 'GET', url: '/api/auth/session', headers: auth.headers })).statusCode, 401);
});

test('expired nonce and session fail closed; wallet change rotates the previous session', async t => {
  const f = await v2Fixture(); t.after(() => f.cleanup());
  const auth = await login(f, f.buyer);
  const issued = (await f.app.inject({ method: 'POST', url: '/api/auth/nonce', headers: { origin: ORIGIN }, payload: { wallet: f.other.address } })).json<{ message: string; nonce: string }>();
  const changed = await f.app.inject({ method: 'POST', url: '/api/auth/verify', headers: auth.headers,
    payload: { wallet: f.other.address, nonce: issued.nonce, signature: signature(f.other, issued.message) } });
  assert.equal(changed.statusCode, 200);
  assert.equal((await f.app.inject({ method: 'GET', url: '/api/auth/session', headers: auth.headers })).statusCode, 401);
  const nextCookie = String(changed.headers['set-cookie']).split(';')[0]!;
  const pending = (await f.app.inject({ method: 'POST', url: '/api/auth/nonce', headers: { origin: ORIGIN }, payload: { wallet: f.buyer.address } })).json<{ message: string; nonce: string }>();
  await f.app.close();
  const file = join(f.settings.dataDir, 'authentication.json');
  const state = JSON.parse(await readFile(file, 'utf8'));
  state.sessions.forEach((s: { expiresAt: number }) => { s.expiresAt = Math.floor(Date.now() / 1000) - 1; });
  state.nonces.forEach((n: { expiresAt: number }) => { n.expiresAt = Math.floor(Date.now() / 1000) - 1; });
  await writeFile(file, JSON.stringify(state));
  const restarted = await createWorker({ chain: f.chain, settings: f.settings, logger: false, ai: f.ai }); t.after(() => restarted.app.close());
  assert.equal((await restarted.app.inject({ method: 'GET', url: '/api/auth/session', headers: { cookie: nextCookie, origin: ORIGIN } })).statusCode, 401);
  assert.equal((await restarted.app.inject({ method: 'POST', url: '/api/auth/verify', headers: { origin: ORIGIN }, payload: {
    wallet: f.buyer.address, nonce: pending.nonce, signature: signature(f.buyer, pending.message),
  } })).statusCode, 401);
});

test('credentialed CORS is restricted to the exact configured origin and exposes no provider credentials', async t => {
  const f = await v2Fixture(); t.after(() => f.cleanup());
  const response = await f.app.inject({ method: 'OPTIONS', url: '/api/v2/orders', headers: { origin: ORIGIN } });
  assert.equal(response.headers['access-control-allow-origin'], ORIGIN);
  assert.equal(response.headers['access-control-allow-credentials'], 'true');
  assert.match(String(response.headers['access-control-allow-headers']), /X-Osid-CSRF/);
  // The workspace fetches trusted public configuration with the same
  // credentialed client as auth; browsers reject it without this header.
  const config = await f.app.inject({ method: 'GET', url: '/api/config', headers: { origin: ORIGIN } });
  assert.equal(config.headers['access-control-allow-origin'], ORIGIN);
  assert.equal(config.headers['access-control-allow-credentials'], 'true');
  const deniedConfig = await f.app.inject({ method: 'GET', url: '/api/config', headers: { origin: 'https://evil.example' } });
  assert.equal(deniedConfig.headers['access-control-allow-origin'], undefined);
  assert.equal(deniedConfig.headers['access-control-allow-credentials'], undefined);
  const denied = await f.app.inject({ method: 'GET', url: '/api/v2/service', headers: { origin: 'https://evil.example' } });
  assert.equal(denied.headers['access-control-allow-origin'], undefined);
  assert.deepEqual(denied.json(), { service: 'product-listing-pack', aiMode: 'fixture', liveConfigured: false, rehearsalStallEnabled: true });
});
