# Fresh adversarial review

Reviewed 2026-11-06 after the local program gate. Scope: deployed local program, generated client, worker funding reconciliation, private downloads, and independent recovery integration. Reviewer artifacts are this report, `programs/checkout/tests/review.test.ts`, and its TAP evidence; the lead owns production fixes.

## Finding

**R1 — Low: unauthenticated challenge requests can invalidate a pending buyer download.** In the reviewed version, `WorkerService.challenge()` generated a new nonce on every request and retained only the last eight. The endpoint requires the publicly known buyer key, without a wallet signature. An arbitrary caller could issue eight requests and evict a still-valid buyer challenge. The buyer's correct signature then returned HTTP 401. This affects availability, not payment custody or unauthorized file disclosure.

Concrete reproduction used a real finalized `Released` job and the production Fastify app. Issue a challenge for the original buyer, issue eight more with the same public buyer key, then submit the original nonce and its correct Ed25519 signature. Before the fix, the last request returned 401 while the challenge was unexpired. The focused live review test records this behavior.

Recommended fix: return the existing unused, unexpired challenge for the same buyer, order and domain, preserving its original expiry. Issue a new nonce only after consumption or expiry. Repeated unauthenticated issuance must neither extend expiry nor evict active challenges. Preserve signature verification, per-order serialization and durable consumption.

Status: **resolved**. The lead changed issuance to return an existing unused, unexpired challenge without extending it, and create a new nonce after consumption or expiry. The real-chain regression now requires eight public requests to return exactly the original message, nonce and expiry. The original buyer signature then succeeds once, replay fails, and a subsequent challenge receives a new nonce.

## Executed evidence

Command: `npx tsx --test --test-reporter=tap --test-reporter-destination=evidence/review-localnet.tap programs/checkout/tests/review.test.ts`.

Final result: **11 passed, 0 failed, 0 skipped; 40.5 seconds.** This includes one parent test and ten focused cases. [Persistent TAP evidence](../evidence/review-localnet.tap) records all landed failed transactions, error metadata, fee accounting, isolated addresses and the fixed challenge regression. The initial reproduction run also passed 11 tests while explicitly asserting the original vulnerable behavior; the current test requires the fixed behavior.

Command: `npx tsc --noEmit -p tsconfig.json` — passed.

Local program: `7cW6fScgHCAWBo9YDQEhuS6brFjssJSmomRN11Xa9iKY`.

Mock mint: `4jMjhk5ZyqnED6BtbQwiqNmcuzMJmti83nEPsceUtN7C`.

Local genesis: `SnGPvUDh3LsTJWSEx8UJAmQLX11u2EmewbJq4vovvBW`.

The suite generated an isolated buyer and merchant, funded only from the disposable workspace deployer, and did not modify the lead's buyer or merchant balances. Private worker storage was temporary and deleted after the test.

All ten deliberately rejected transactions were broadcast with preflight skipped, landed on the local ledger, and had non-null `meta.err`. Each charged 10,000 lamports in network fees. The suite compares complete isolated buyer, job, vault and token-account data and lamports before and after each rejection. Transaction metadata independently confirms that the fee payer lost only the fee.

| Rejection | Local transaction signature |
| --- | --- |
| Insufficient token balance after job/vault initialization | `3Aq6gc8FmVZ6jy2a9bfGXjcHvhiKPKmPbnZ2y6KpK69p3uBTe2q6V71kUY7cHDXguwGk5sdkJF4b5Wjsn7de41DE` |
| Approve followed by refund in the same transaction | `2KPKfzzMjbENJwZrudq2rSF6X6ZYF6a4pnzJA2jKYbktYrgCEheKZuNaMLRVCGNU8ZPttdPsvfp7QzQKXfq2tTHq` |
| Wrong buyer signer | `2JiG6LfPbRiWzQXuL9KXZqNbnV58Y5cM7b99mbZ2QLXAEUZ7FJNXeRXgB3T3rzLGnXh5tELofpTJNyCvbUqtz4SK` |
| Wrong merchant destination | `3cCwgcrXC9GVzeVSHeqHfUP2fwGTNdYPDGfAk4FDPuNCvsttc63ZwckggU9CCqV2z5KtshBD4FKiDiY6JbA3GKVQ` |
| Approve replay after release | `4qGAj3b4JxXjcfJz8Lutqcmj6PgzHDLLhornx7SpVThCr4Uwt5APgKmtbUQDPZk4Ymf5aPNp2YEmbENAPQsJjMaa` |
| Funding replay after release | `55ynHdG9ZJjGNbJceZjMnNinBmwA4V2gbtZmLyjB51AomGN7WaoAZZFqb66wat43i1JSvRoA4uSMRNnNUTQbCQaa` |
| Approval after expiry | `3QnoMLBSgqUzvofyrYeKfv3MziHG3QsDpzzV8YXXF7CHaGFFGCzoFg8xEkC9cWMrpWKjTtRV1XmM4pwKsUAkkRXH` |
| Refund followed by approve in the same transaction | `4Y8NBWjd34R6Lq2jGYgXAB9jBr75Xp3y8zDMu25ZVJddWVbY2uSCcQkf1u4bPTBwQKwDmxxyn3NMEjbKBtHEZxfV` |
| Competing approval after refund | `2HtUrbitwM2bLmmnkds1fNuZBdeoBMWQjMph72yBX2LpM4jQgt5LM5ygJeuMo3CSZr38AueArtPnjjE8YaW7pUf6` |
| Repeated refund | `2TWptwEdc3hxv7gYtmHEKB2q5fWx2ZUmS4xooDpfg5mTr2Qit5JRMASLCYQRWWprGDQWU8UEVEmbAtdiyKm1GnwT` |

The multi-instruction cases first execute a valid token transfer and then fail on the second settlement instruction with `NotFunded`. Full transaction rollback restores the original funded job and deposit. The successful release/refund transactions use the same deployed program, without a merchant service participating in settlement.

## Verified invariants

- Job and vault PDAs bind buyer and job ID; the retained job record prevents reinitialization and replay.
- Funding binds configured legacy SPL mint, positive integer amount, buyer, merchant and bounded chain-time expiry. Token authorities and canonical recipient ATAs are checked on chain.
- Only the recorded buyer can settle. Approval requires chain time before expiry; refund requires chain time at or after expiry. Settlement transfers the recorded amount and persists the terminal state atomically.
- Vault custody belongs to the job PDA. Substitute vaults, token programs, mints and destinations are constrained. Existing program-gate tests cover these additional rejections; the new suite strengthens selected cases with actual failed ledger transactions.
- Worker processing checks finalized job fields and vault authority, mint, owner and funded balance against the saved quote. HTTP transaction signatures do not authorize processing.
- Real finalized funding produced a durable WebP before readiness. Before release, challenge issuance was denied. After release, a second wallet could neither issue its own challenge nor forge the buyer's signature.
- Concurrent identical signed download requests returned exactly one HTTP 200 and one 401. Used nonce rejection and fresh authorized download survived a worker restart using the same durable storage. Private file paths returned 404 and download responses used `Cache-Control: no-store`.
- Static inspection confirms the independent recovery page builds from compiled public configuration and direct chain reads. It has no merchant API request; the lead's separate UI/offline rehearsal must prove the full browser flow.

## Limits

This review exercised localnet, not Devnet, and used actual chain reads with in-process Fastify injection for HTTP behavior. It does not itself prove a browser wallet rehearsal or a Devnet deployment. No high or medium severity custody, consent, destination, amount, expiry, replay or private-file disclosure flaw was found in this scope.

The documented trust boundaries remain: the deployment authority can upgrade the program, test mint authority controls mock-token issuance, files depend on merchant storage, and one worker process owns each storage directory. Account rent and accidental vault surplus remain locked by design. Public quote/upload endpoints have no general production rate limiting; the demo is a local service, not an Internet-hardened deployment.
