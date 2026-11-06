import assert from 'node:assert/strict';
import { test } from 'node:test';
import { newChallenge, verifyWalletSignature } from '../src/security.js';
import type { StoredOrder } from '../src/types.js';
import { signature, walletFixture } from './helpers.js';

test('Ed25519 signature verification rejects a different wallet, message, malformed signature, and noncanonical base64', () => {
  const buyer = walletFixture();
  const other = walletFixture();
  const message = 'Holdfast download challenge';
  const signed = signature(buyer, message);
  assert.equal(verifyWalletSignature(buyer.bytes, message, signed), true);
  assert.equal(verifyWalletSignature(other.bytes, message, signed), false);
  assert.equal(verifyWalletSignature(buyer.bytes, `${message}!`, signed), false);
  assert.equal(verifyWalletSignature(buyer.bytes, message, 'invalid'), false);
  assert.equal(verifyWalletSignature(buyer.bytes, message, `${signed}\n`), false);
  assert.equal(verifyWalletSignature(buyer.bytes, message, signed.slice(0, -1)), false);
});

test('challenge binds buyer, order, domain, download purpose, expiry, and fresh nonce', () => {
  const order = { buyer: 'Buyer', jobId: 'a'.repeat(64), jobAddress: 'Job' } as StoredOrder;
  const first = newChallenge(order, 'http://localhost:8787', 12345);
  const second = newChallenge(order, 'http://localhost:8787', 12345);
  assert.notEqual(first.nonce, second.nonce);
  for (const field of ['Buyer: Buyer', `Job ID: ${order.jobId}`, 'Job address: Job', 'Purpose: download', 'Domain: http://localhost:8787', 'Expires at: 12345', `Nonce: ${first.nonce}`]) {
    assert.ok(first.message.includes(field), field);
  }
});
