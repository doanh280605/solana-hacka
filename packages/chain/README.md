# osid escrow client

The package keeps its historical name, `@holdfast/chain`, for compatible imports.
New purchases use additive V2 accounts; existing V1 addresses and instructions
remain readable and refundable.

V2 separates quote expiry from execution/refund expiry, binds the exact terms,
and requires a provider submission before buyer approval:

```ts
import {
  deriveJobV2Address, computeTermsHash, hashCanonical,
  buildFundV2Transaction, buildApproveV2Transaction, buildRefundTransaction,
} from '@holdfast/chain';

const jobAddress = deriveJobV2Address(config, buyer, quote.jobId);
const specHash = await hashCanonical(quote.specification);
const termsHash = await computeTermsHash({
  programId: config.programId, jobAddress, jobId: quote.jobId, buyer,
  merchant: config.merchant, provider: config.provider!, mint: config.mint,
  amount: config.amount, expiresAt: quote.expiresAt,
  quoteExpiresAt: quote.quoteExpiresAt, inputHash: quote.inputHash, specHash,
});
if (termsHash !== quote.termsHash) throw new Error('Quote does not match the agreement');

const funding = await buildFundV2Transaction(connection, config, {
  buyer, jobId: quote.jobId, expiresAt: quote.expiresAt,
  quoteExpiresAt: quote.quoteExpiresAt, inputHash: quote.inputHash,
  specHash, termsHash,
});
// Persist jobAddress before asking the buyer to sign and broadcast funding.
// Review the pack and recompute its manifest hash before a separate buyer action:
const approval = await buildApproveV2Transaction(connection, config, {
  buyer, jobAddress, resultHash: await hashCanonical(reviewedManifest),
});
// Alternative at/after execution expiry; requires buyer confirmation and RPC only:
const recovery = await buildRefundTransaction(connection, config, { buyer, jobAddress });
```

`fetchJob` verifies finalized owner, account discriminator/size, version, PDA and
V2 terms commitment. It reports `version: 1 | 2`. Refund automatically selects
the correct instruction and follows the recorded mint/buyer. It does not call
merchant or authentication services. V2 approval must supply the exact frozen
`resultHash`; the legacy approval builder rejects V2 accounts.

`PublicConfig.provider` is optional for legacy recovery; V2 funding requires it.
The dedicated provider signs `buildSubmitV2Transaction` after persisting a complete
pack. `transactionSignature(signedTransaction)` exposes the exact broadcast
signature for persistence before sending. Keep signed bytes and retry those
same bytes after uncertainty. Never give a worker buyer or upgrade-authority keys.

Canonical JSON recursively sorts keys by JavaScript code-unit order and keeps
array order, exact strings and JSON escaping. It accepts null, booleans, strings,
safe integer numbers, arrays and plain objects; ambiguous values, sparse arrays,
accessors and cycles are rejected. Hashes use SHA-256 and lowercase hex. The V2
binary terms encoding and manifest schema are defined in
[the interface agreement](../../docs/INTERFACES.md). Hashes bind specifications and
artifact bytes; buyer review determines whether the work is acceptable.

```sh
npm run typecheck --workspace @holdfast/chain
node --import tsx --test packages/chain/test/*.test.ts
```

## Historical V1 example

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

A merchant integration must still verify finalized funding against its quote, persist its result, authenticate the buyer before private delivery, and recover durable metadata after restart. This example covers the historical V1 payment interface; the PNG reference service demonstrates V1 delivery. See [the shared interface](../../docs/INTERFACES.md) and [V1 verification script](../../scripts/verify.ts).

Validate the example without signing or submitting transactions:

```sh
npm run typecheck --workspace @holdfast/chain
```
