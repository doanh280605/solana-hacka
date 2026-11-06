import { createHash, createPublicKey, randomBytes, verify } from 'node:crypto';
import type { Challenge, StoredOrder } from './types.js';

const ED25519_SPKI_PREFIX = Buffer.from('302a300506032b6570032100', 'hex');

export function sha256(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

export function newChallenge(order: StoredOrder, domain: string, expiresAt: number): Challenge {
  const nonce = randomBytes(32).toString('hex');
  const message = [
    'Holdfast private download authorization',
    `Domain: ${domain}`,
    'Purpose: download',
    `Buyer: ${order.buyer}`,
    `Job ID: ${order.jobId}`,
    `Job address: ${order.jobAddress}`,
    `Expires at: ${expiresAt}`,
    `Nonce: ${nonce}`,
  ].join('\n');
  return { nonce, message, expiresAt, used: false };
}

export function verifyWalletSignature(publicKey: Uint8Array, message: string, signature: unknown): boolean {
  if (publicKey.length !== 32 || typeof signature !== 'string' || !/^[A-Za-z0-9+/]{86}==$/.test(signature)) {
    return false;
  }
  const bytes = Buffer.from(signature, 'base64');
  if (bytes.length !== 64 || bytes.toString('base64') !== signature) return false;
  try {
    const key = createPublicKey({
      key: Buffer.concat([ED25519_SPKI_PREFIX, Buffer.from(publicKey)]),
      type: 'spki',
      format: 'der',
    });
    return verify(null, Buffer.from(message, 'utf8'), key, bytes);
  } catch {
    return false;
  }
}
