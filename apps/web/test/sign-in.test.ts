import assert from 'node:assert/strict';
import { generateKeyPairSync, sign } from 'node:crypto';
import { test } from 'node:test';
import { PublicKey } from '@holdfast/chain';
import { signInChainId, signInChallenge, signInErrorMessage, signInInputFromChallenge, validateSignInMessage } from '../src/sign-in.js';
import type { NativeSignInInput, NativeSignInOutput } from '../src/types.js';

const mismatch = "The app's signature request cannot be shown as the chain ID does not match the provided chain ID for verification.";
const page = { host: 'localhost:5173', origin: 'http://localhost:5173' };
const pair = generateKeyPairSync('ed25519');
const publicKey = new PublicKey(pair.publicKey.export({ type: 'spki', format: 'der' }).subarray(-32));
const wallet = publicKey.toBase58();
const nonce = 'a'.repeat(64);
const now = Date.parse('2026-11-08T12:00:00.000Z');
const expiresAt = now / 1000 + 300;
const message = [
  `${page.host} wants you to sign in with your Solana account:`, wallet, '',
  'Sign in to osid (no payment authorization)', '', `URI: ${page.origin}/app`,
  'Version: 1', 'Chain ID: solana:devnet', `Nonce: ${nonce}`,
  `Issued At: ${new Date(now).toISOString()}`, `Expiration Time: ${new Date(expiresAt * 1000).toISOString()}`,
].join('\n');
const challenge = { message, nonce, expiresAt };
const options = { page, now };
const expectedBytes = new TextEncoder().encode(message);
function nativeOutput(signedMessage = expectedBytes): NativeSignInOutput {
  return { account: { address: wallet, publicKey: publicKey.toBytes() }, signedMessage: signedMessage.slice(), signature: new Uint8Array(sign(null, signedMessage, pair.privateKey)), signatureType: 'ed25519' };
}

test('native signIn receives only fields derived from the validated server challenge', async () => {
  let input: NativeSignInInput | undefined;
  let fallback = 0;
  const provider = { publicKey, async signIn(value: NativeSignInInput) { input = value; return nativeOutput(); }, async signMessage() { fallback++; return { signature: new Uint8Array(64) }; } };
  const signature = await signInChallenge(provider, challenge, wallet, 'devnet', options);
  assert.equal(signature.length, 64); assert.equal(fallback, 0);
  assert.deepEqual(input, { domain: page.host, address: wallet, statement: 'Sign in to osid (no payment authorization)', uri: `${page.origin}/app`, version: '1', chainId: 'solana:devnet', nonce, issuedAt: new Date(now).toISOString(), expirationTime: new Date(expiresAt * 1000).toISOString() });
  assert.deepEqual(signInInputFromChallenge(challenge, wallet, 'devnet', options), input);
});

test('absent native feature uses one exact signMessage fallback', async () => {
  let count = 0;
  const provider = { publicKey, async signMessage(bytes: Uint8Array, encoding?: string) { count++; assert.deepEqual(bytes, expectedBytes); assert.equal(encoding, 'utf8'); return { signature: nativeOutput().signature }; } };
  assert.equal((await signInChallenge(provider, challenge, wallet, 'devnet', options)).length, 64);
  assert.equal(count, 1);
});

test('native cancellation and chain rejection never fall back to signMessage', async () => {
  for (const rejection of [new Error('User rejected the request'), new Error(mismatch)]) {
    let fallback = 0;
    const provider = { publicKey, async signIn(): Promise<NativeSignInOutput> { throw rejection; }, async signMessage() { fallback++; return { signature: nativeOutput().signature }; } };
    await assert.rejects(signInChallenge(provider, challenge, wallet, 'devnet', options), error => error === rejection);
    assert.equal(fallback, 0);
  }
});

test('native account, public key, signed bytes and signature type tampering fail before verification', async () => {
  const other = new PublicKey(new Uint8Array(32).fill(7));
  const cases: [NativeSignInOutput, RegExp][] = [
    [{ ...nativeOutput(), account: { address: other.toBase58(), publicKey: other.toBytes() } }, /different sign-in account/],
    [{ ...nativeOutput(), account: { address: wallet, publicKey: other.toBytes() } }, /different sign-in public key/],
    [nativeOutput(new TextEncoder().encode(`${message}\n`)), /different sign-in message/],
    [{ ...nativeOutput(), signatureType: 'secp256k1' }, /unsupported sign-in signature type/],
    [{ ...nativeOutput(), signature: new Uint8Array(63) }, /invalid Ed25519 signature/],
    [{ ...nativeOutput(), signature: new Uint8Array(64) }, /invalid Ed25519 signature/],
  ];
  for (const [output, error] of cases) await assert.rejects(signInChallenge({ publicKey, async signIn() { return output; } }, challenge, wallet, 'devnet', options), error);
});

test('native signature type may be omitted but the exact 32-byte public key is mandatory', async () => {
  const output = nativeOutput(); delete output.signatureType;
  assert.equal((await signInChallenge({ publicKey, async signIn() { return output; } }, challenge, wallet, 'devnet', options)).length, 64);
  for (const account of [{ address: wallet }, { address: wallet, publicKey: new Uint8Array(31) }]) {
    const missing = { ...nativeOutput(), account } as unknown as NativeSignInOutput;
    await assert.rejects(signInChallenge({ publicKey, async signIn() { return missing; } }, challenge, wallet, 'devnet', options), /different sign-in public key/);
  }
});

test('wallet or session epoch changes during native prompt are rejected', async () => {
  const changed: { publicKey: PublicKey | null; signIn(): Promise<NativeSignInOutput> } = { publicKey, async signIn() { changed.publicKey = null; return nativeOutput(); } };
  await assert.rejects(signInChallenge(changed, challenge, wallet, 'devnet', options), /Wallet changed/);
  let current = true;
  await assert.rejects(signInChallenge({ publicKey, async signIn() { current = false; return nativeOutput(); } }, challenge, wallet, 'devnet', { ...options, isCurrent: () => current }), /Wallet changed/);
});

test('fallback invalid signature and wallet changes are rejected', async () => {
  await assert.rejects(signInChallenge({ publicKey, async signMessage() { return { signature: new Uint8Array(64) }; } }, challenge, wallet, 'devnet', options), /invalid Ed25519 signature/);
  const provider: { publicKey: PublicKey | null; signMessage(): Promise<{ signature: Uint8Array }> } = { publicKey, async signMessage() { provider.publicKey = null; return { signature: nativeOutput().signature }; } };
  await assert.rejects(signInChallenge(provider, challenge, wallet, 'devnet', options), /Wallet changed/);
});

test('invalid server challenge fails before calling either signing method', async () => {
  let calls = 0;
  const provider = { publicKey, async signIn() { calls++; return nativeOutput(); }, async signMessage() { calls++; return { signature: nativeOutput().signature }; } };
  await assert.rejects(signInChallenge(provider, { ...challenge, message: message.replace(page.host, 'evil.example') }, wallet, 'devnet', options), /does not match/);
  assert.equal(calls, 0);
});

test('canonical Devnet and localnet chain IDs are distinct; wrong and obsolete chains fail closed', () => {
  assert.equal(signInChainId('devnet'), 'solana:devnet'); assert.equal(signInChainId('localnet'), 'localnet');
  assert.throws(() => signInChainId('mainnet'), /Unsupported/);
  assert.doesNotThrow(() => validateSignInMessage(message, wallet, nonce, expiresAt, 'devnet', page, now));
  for (const chain of ['mainnet', 'testnet', 'localnet', 'devnet', 'solana:localnet']) assert.throws(() => validateSignInMessage(message.replace('Chain ID: solana:devnet', `Chain ID: ${chain}`), wallet, nonce, expiresAt, 'devnet', page, now), /does not match/);
  assert.doesNotThrow(() => validateSignInMessage(message.replace('Chain ID: solana:devnet', 'Chain ID: localnet'), wallet, nonce, expiresAt, 'localnet', page, now));
});

test('network guidance preserves domain, wallet, nonce and expiration binding', () => {
  for (const changed of [message.replace(page.host, 'evil.example'), message.replace(wallet, `${wallet}1`), message.replace(nonce, 'b'.repeat(64))]) assert.throws(() => validateSignInMessage(changed, wallet, nonce, expiresAt, 'devnet', page, now), /does not match/);
  assert.throws(() => validateSignInMessage(message, wallet, nonce, expiresAt, 'devnet', page, expiresAt * 1000), /expired timestamps/);
});

test('Phantom mismatch explains configured Devnet without claiming network detection', () => {
  for (const error of [new Error(mismatch), { code: -32000, message: mismatch }, mismatch]) {
    const detail = signInErrorMessage(error, 'devnet', mismatch);
    assert.match(detail, /Settings > Developer Settings > Testnet Mode > Solana Devnet/);
    assert.match(detail, /reload this page and sign in again/); assert.match(detail, /cannot detect your wallet/); assert.ok(!detail.includes('mainnet'));
  }
});

test('unrelated provider and application errors keep their existing formatted message', () => {
  for (const message of ['Wallet request declined.', 'Cannot reach this service.', 'Wrong chain', 'This quote has expired.']) assert.equal(signInErrorMessage(new Error(message), 'devnet', message), message);
  assert.equal(signInErrorMessage({ message: 'User rejected the request' }, 'devnet', 'Wallet request declined.'), 'Wallet request declined.');
  assert.equal(signInErrorMessage(null, 'devnet', 'Unknown wallet error'), 'Unknown wallet error');
});
