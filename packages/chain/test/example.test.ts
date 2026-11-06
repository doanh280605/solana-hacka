import assert from 'node:assert/strict';
import test from 'node:test';
import { Keypair, SystemProgram } from '@solana/web3.js';
import { checkoutClient } from '../examples/checkout.js';
import { CHECKOUT_IDL, Connection, Transaction, type PublicConfig } from '../src/index.js';

test('SDK preserves the broadcast signature and recovery address when confirmation fails', async () => {
  const originalFetch = globalThis.fetch;
  const originalBlockhash = Connection.prototype.getLatestBlockhash;
  const originalSend = Connection.prototype.sendRawTransaction;
  const originalConfirm = Connection.prototype.confirmTransaction;
  const buyer = Keypair.generate();
  const signature = '4'.repeat(88);
  const confirmationFailure = new Error('Mock confirmation RPC unavailable');
  const settings: PublicConfig = {
    rpcUrl: 'https://sdk-regression.invalid', programId: CHECKOUT_IDL.address,
    mint: Keypair.generate().publicKey.toBase58(), merchant: Keypair.generate().publicKey.toBase58(),
    decimals: 6, amount: '5000000', cluster: 'devnet',
  };
  let networkCalls = 0, signatures = 0, submissions = 0, confirmations = 0;
  try {
    // Every RPC operation is stubbed. Any accidental real fetch fails the test.
    globalThis.fetch = async () => { networkCalls++; throw new Error('Real network access is forbidden in this test'); };
    Connection.prototype.getLatestBlockhash = async () => ({
      blockhash: SystemProgram.programId.toBase58(), lastValidBlockHeight: 100,
    });
    Connection.prototype.sendRawTransaction = async raw => {
      submissions++;
      const transaction = Transaction.from(raw);
      assert(transaction.feePayer?.equals(buyer.publicKey));
      assert(transaction.verifySignatures(), 'The mock receives the buyer-signed transaction');
      return signature;
    };
    Connection.prototype.confirmTransaction = (async (value: unknown) => {
      confirmations++;
      assert.equal(value, signature);
      throw confirmationFailure;
    }) as typeof originalConfirm;
    const client = checkoutClient(settings, {
      publicKey: buyer.publicKey,
      async signTransaction(transaction) {
        signatures++;
        transaction.partialSign(buyer);
        return transaction;
      },
    });
    const purchase = client.prepareFunding({
      jobId: 'b'.repeat(64), expiresAt: Math.floor(Date.now() / 1000) + 120,
    });
    assert.match(purchase.jobAddress, /^[1-9A-HJ-NP-Za-km-z]{32,44}$/);
    assert.equal(purchase.recoveryPath, `/recover?job=${purchase.jobAddress}`);
    assert.equal(signatures, 0, 'Preparation must expose recovery information before requesting a signature');
    assert.equal(submissions, 0);
    await assert.rejects(purchase.fund(), (error: unknown) => {
      assert(error instanceof Error);
      const reported = error as Error & { signature?: string; explorer?: string };
      assert.equal(reported.signature, signature);
      assert.equal(reported.explorer, `https://explorer.solana.com/tx/${signature}?cluster=devnet`);
      assert(reported.message.includes(signature));
      assert.equal(reported.cause, confirmationFailure);
      return true;
    });
    assert.equal(signatures, 1, 'An uncertain broadcast must not request a replacement signature');
    assert.equal(submissions, 1, 'An uncertain broadcast must not submit a replacement transaction');
    assert.equal(confirmations, 1);
    assert.equal(networkCalls, 0);
  } finally {
    globalThis.fetch = originalFetch;
    Connection.prototype.getLatestBlockhash = originalBlockhash;
    Connection.prototype.sendRawTransaction = originalSend;
    Connection.prototype.confirmTransaction = originalConfirm;
  }
});
