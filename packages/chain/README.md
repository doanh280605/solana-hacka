# Reusing the checkout client

[examples/checkout.ts](examples/checkout.ts) is a small, typechecked browser-wallet integration. It reuses the deployed program and existing transaction builders. It does not start a worker, embed keys, or send transactions on import.

```ts
import { checkoutClient } from './examples/checkout.js';

// Trusted public settings for the existing Devnet deployment; same configured mint.
// A second merchant can supply its own merchant public key; this demo stays at 5 mock USDC.
const checkout = checkoutClient(merchantConfig, connectedWallet);

// The merchant quote supplies a unique 64-character hex job ID and chain expiry.
const purchase = checkout.prepareFunding({ jobId: quote.jobId, expiresAt: quote.expiresAt });
// Persist purchase.jobAddress and purchase.recoveryPath before broadcasting.
const funding = await purchase.fund();

// On a later explicit buyer action, after reviewing the persisted result:
await checkout.approve(purchase.jobAddress);

// Alternative terminal action for an unapproved job, at/after chain expiry:
// await checkout.refund(purchase.jobAddress);
```

Wire funding and approval to separate user actions. Refund is the alternative to approval; it reads the recorded job and calls Solana directly, without the merchant API. The program retains the terminal job, so do not reuse a job ID or automatically replace a transaction after a confirmation timeout. Confirmation errors carry the broadcast `signature` and `explorer`; save these and inspect that same transaction first.

A merchant integration must still verify finalized funding against its quote, persist its result, authenticate the buyer before private delivery, and recover durable metadata after restart. This example covers the payment interface; the PNG merchant demonstrates those delivery responsibilities. See [the shared interface](../../docs/INTERFACES.md) and [live verification script](../../scripts/verify.ts).

Validate the example without signing or submitting transactions:

```sh
npm run typecheck --workspace @holdfast/chain
```
