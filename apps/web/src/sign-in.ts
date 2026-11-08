import { PublicKey } from '@holdfast/chain';
import type { InjectedWallet, NativeSignInInput, NativeSignInOutput, SignInChallenge } from './types';

type SignInPage = { host: string; origin: string };
type SignInOptions = { page?: SignInPage; now?: number; isCurrent?: () => boolean };

export function signInChainId(cluster: string): 'solana:devnet' | 'localnet' {
  if (cluster === 'devnet') return 'solana:devnet';
  if (cluster === 'localnet') return 'localnet';
  throw new Error('Unsupported sign-in network.');
}

export function validateSignInMessage(message: string, wallet: string, nonce: string, expiresAt: number, cluster: string, page: SignInPage = window.location, now = Date.now()): void {
  if (typeof message !== 'string' || message.length > 4096 || typeof nonce !== 'string' || !/^[a-z0-9]{8,128}$/i.test(nonce) || !Number.isSafeInteger(expiresAt)) throw new Error('The sign-in request is invalid.');
  const lines = message.split('\n');
  const expected = [
    `${page.host} wants you to sign in with your Solana account:`, wallet, '',
    'Sign in to osid (no payment authorization)', '', `URI: ${page.origin}/app`,
    'Version: 1', `Chain ID: ${signInChainId(cluster)}`, `Nonce: ${nonce}`,
  ];
  if (lines.length !== 11 || expected.some((line, index) => lines[index] !== line)) throw new Error('The sign-in request does not match this site, wallet or purpose.');
  const issuedAt = Date.parse(lines[9].replace(/^Issued At: /, ''));
  const expiration = Date.parse(lines[10].replace(/^Expiration Time: /, ''));
  if (!lines[9].startsWith('Issued At: ') || !lines[10].startsWith('Expiration Time: ') || !Number.isFinite(issuedAt) || !Number.isFinite(expiration) || expiration <= now || issuedAt > now + 60_000 || expiration <= issuedAt || expiration - issuedAt > 15 * 60_000 || Math.abs(expiration / 1000 - expiresAt) > 1) throw new Error('The sign-in request has invalid or expired timestamps.');
}

export function signInInputFromChallenge(challenge: SignInChallenge, wallet: string, cluster: string, options: SignInOptions = {}): NativeSignInInput {
  validateSignInMessage(challenge.message, wallet, challenge.nonce, challenge.expiresAt, cluster, options.page, options.now);
  const lines = challenge.message.split('\n');
  // These strings come from the exact, validated persisted server message, never wallet defaults.
  return {
    domain: lines[0].slice(0, -' wants you to sign in with your Solana account:'.length),
    address: lines[1], statement: lines[3], uri: lines[5].slice('URI: '.length),
    version: lines[6].slice('Version: '.length) as '1', chainId: lines[7].slice('Chain ID: '.length) as NativeSignInInput['chainId'],
    nonce: lines[8].slice('Nonce: '.length), issuedAt: lines[9].slice('Issued At: '.length), expirationTime: lines[10].slice('Expiration Time: '.length),
  };
}

function sameBytes(actual: Uint8Array, expected: Uint8Array): boolean {
  return actual.byteLength === expected.byteLength && actual.every((byte, index) => byte === expected[index]);
}

function nativeSignature(output: NativeSignInOutput, wallet: string, message: Uint8Array): Uint8Array {
  if (!output || !output.account || output.account.address !== wallet) throw new Error('The wallet returned a different sign-in account.');
  if (!(output.account.publicKey instanceof Uint8Array) || output.account.publicKey.byteLength !== 32 || !sameBytes(output.account.publicKey, new PublicKey(wallet).toBytes())) throw new Error('The wallet returned a different sign-in public key.');
  if (output.signatureType !== undefined && output.signatureType !== 'ed25519') throw new Error('The wallet returned an unsupported sign-in signature type.');
  if (!(output.signedMessage instanceof Uint8Array) || !sameBytes(output.signedMessage, message)) throw new Error('The wallet signed a different sign-in message.');
  return output.signature;
}

export async function signInChallenge(provider: Pick<InjectedWallet, 'publicKey' | 'signIn' | 'signMessage'>, challenge: SignInChallenge, wallet: string, cluster: string, options: SignInOptions = {}): Promise<Uint8Array> {
  const input = signInInputFromChallenge(challenge, wallet, cluster, options);
  const message = new TextEncoder().encode(challenge.message);
  const assertCurrent = () => { if (provider.publicKey?.toString() !== wallet || options.isCurrent?.() === false) throw new Error('Wallet changed. Sign in again.'); };
  assertCurrent();
  let signature: Uint8Array;
  if (typeof provider.signIn === 'function') {
    const output = await provider.signIn(input);
    assertCurrent();
    signature = nativeSignature(output, wallet, message);
  } else {
    if (typeof provider.signMessage !== 'function') throw new Error('Connect a wallet with sign-in or message-signing support.');
    const output = await provider.signMessage(message.slice(), 'utf8');
    assertCurrent();
    signature = output?.signature;
  }
  if (!(signature instanceof Uint8Array) || signature.byteLength !== 64) throw new Error('The wallet returned an invalid Ed25519 signature.');
  const checked = signature.slice();
  // Server verification remains authoritative; this prevents malformed/tampered wallet output from being posted.
  if (!globalThis.crypto?.subtle) throw new Error('This browser cannot verify wallet signatures. Use a current browser on localhost or HTTPS.');
  const key = await crypto.subtle.importKey('raw', new PublicKey(wallet).toBytes().slice().buffer, { name: 'Ed25519' }, false, ['verify']);
  if (!await crypto.subtle.verify({ name: 'Ed25519' }, key, checked.buffer, message.buffer)) throw new Error('The wallet returned an invalid Ed25519 signature.');
  assertCurrent();
  return checked;
}

export function signInErrorMessage(error: unknown, cluster: string, fallback: string): string {
  const message = typeof error === 'string' ? error : error && typeof error === 'object' && 'message' in error && typeof error.message === 'string' ? error.message : '';
  if (!/signature request cannot be shown/i.test(message) || !/chain[ -]?id does not match/i.test(message)) return fallback;
  if (cluster === 'devnet') return 'Phantom rejected this network-bound sign-in. osid uses Solana Devnet. In Phantom: Settings > Developer Settings > Testnet Mode > Solana Devnet. Then reload this page and sign in again. The app cannot detect your wallet’s active network.';
  return 'Phantom rejected this network-bound sign-in. Select the same Solana network as this app, then reload this page and sign in again. The app cannot detect your wallet’s active network.';
}
