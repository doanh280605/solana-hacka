import { PublicKey } from '@solana/web3.js';
import { Buffer } from 'buffer';

export const V2_SCHEMA_VERSION = 2;
export interface TermsV2 {
  programId: string | PublicKey;
  jobAddress: string | PublicKey;
  jobId: string;
  buyer: string | PublicKey;
  merchant: string | PublicKey;
  provider: string | PublicKey;
  mint: string | PublicKey;
  amount: string;
  expiresAt: number;
  quoteExpiresAt: number;
  inputHash: string;
  specHash: string;
}

/** Exact JSON encoding: sorted object keys, retained array order, safe integers only. */
export function canonicalJson(value: unknown): string {
  const ancestors = new Set<object>();
  function encode(input: unknown): string {
    if (input === null) return 'null';
    if (typeof input === 'string' || typeof input === 'boolean') return JSON.stringify(input);
    if (typeof input === 'number') {
      if (!Number.isSafeInteger(input)) throw new Error('Canonical JSON supports only safe integer numbers.');
      return JSON.stringify(input);
    }
    if (typeof input !== 'object') throw new Error('Unsupported canonical JSON value.');
    if (ancestors.has(input)) throw new Error('Canonical JSON cannot contain cycles.');
    const prototype = Object.getPrototypeOf(input);
    if (!Array.isArray(input) && prototype !== Object.prototype && prototype !== null) {
      throw new Error('Canonical JSON requires plain objects.');
    }
    if (Object.getOwnPropertySymbols(input).length) throw new Error('Canonical JSON cannot contain symbol keys.');
    ancestors.add(input);
    try {
      if (Array.isArray(input)) {
        const elements: string[] = [];
        for (let index = 0; index < input.length; index++) {
          const descriptor = Object.getOwnPropertyDescriptor(input, String(index));
          if (!descriptor || !('value' in descriptor)) throw new Error('Canonical JSON cannot contain sparse arrays or accessors.');
          elements.push(encode(descriptor.value));
        }
        if (Object.keys(input).some(key => !/^(0|[1-9]\d*)$/.test(key) || Number(key) >= input.length)) {
          throw new Error('Canonical JSON arrays cannot contain extra properties.');
        }
        return `[${elements.join(',')}]`;
      }
      return `{${Object.keys(input).sort().map(key => {
        const descriptor = Object.getOwnPropertyDescriptor(input, key)!;
        if (!('value' in descriptor)) throw new Error('Canonical JSON cannot contain accessors.');
        return `${JSON.stringify(key)}:${encode(descriptor.value)}`;
      }).join(',')}}`;
    } finally {
      ancestors.delete(input);
    }
  }
  return encode(value);
}

async function sha256(bytes: Uint8Array): Promise<string> {
  // Web Crypto works in secure browser contexts (including localhost) and Node 22.
  const digest = await globalThis.crypto.subtle.digest('SHA-256', Uint8Array.from(bytes));
  return Buffer.from(digest).toString('hex');
}
export async function hashCanonical(value: unknown): Promise<string> {
  return sha256(new TextEncoder().encode(canonicalJson(value)));
}
export function hashBytes(hash: string): Buffer {
  if (!/^[0-9a-f]{64}$/.test(hash)) throw new Error('Commitment must be 64 lowercase hexadecimal characters.');
  return Buffer.from(hash, 'hex');
}
export function nonzeroHashBytes(hash: string): Buffer {
  const bytes = hashBytes(hash);
  if (bytes.every(byte => byte === 0)) throw new Error('Commitment must be nonzero.');
  return bytes;
}
export function integerSeconds(value: number): number {
  if (!Number.isSafeInteger(value)) throw new Error('Expiry must be integer chain seconds.');
  return value;
}

/** Binary terms encoding must match compute_terms_hash_v2 in the program. */
export async function computeTermsHash(terms: TermsV2): Promise<string> {
  if (!/^[0-9a-f]{64}$/.test(terms.jobId)) throw new Error('Job ID must be 64 lowercase hexadecimal characters.');
  if (!/^[1-9]\d*$/.test(terms.amount)) throw new Error('Amount must be a positive integer string.');
  const amount = BigInt(terms.amount);
  if (amount > 0xffff_ffff_ffff_ffffn) throw new Error('Amount exceeds u64.');
  const integers = Buffer.alloc(26);
  integers.writeBigUInt64LE(amount, 0);
  integers.writeBigInt64LE(BigInt(integerSeconds(terms.expiresAt)), 8);
  integers.writeBigInt64LE(BigInt(integerSeconds(terms.quoteExpiresAt)), 16);
  integers.writeUInt16LE(V2_SCHEMA_VERSION, 24);
  return sha256(Buffer.concat([
    Buffer.from('osid:terms:v2\0', 'utf8'),
    new PublicKey(terms.programId).toBuffer(),
    new PublicKey(terms.jobAddress).toBuffer(),
    Buffer.from(terms.jobId, 'hex'),
    new PublicKey(terms.buyer).toBuffer(),
    new PublicKey(terms.merchant).toBuffer(),
    new PublicKey(terms.provider).toBuffer(),
    new PublicKey(terms.mint).toBuffer(),
    integers,
    nonzeroHashBytes(terms.inputHash),
    nonzeroHashBytes(terms.specHash),
  ]));
}
