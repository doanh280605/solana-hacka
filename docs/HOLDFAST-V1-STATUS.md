# Execution status

Updated November 6, 2026. **All three technical gates pass. Devnet payment release and refund with the merchant API offline are verified.**

Source: [public GitHub repository](https://github.com/doanh280605/solana-hacka), default branch `main`. Local integration branch: `integration/holdfast`.

## Delivered

Rust/Anchor checkout, generated-IDL TypeScript client, durable PNG-to-WebP merchant, wallet checkout and independent recovery route; pinned npm/Cargo/tool versions, example config, exact setup commands, focused tests, repeatable rehearsals and submission materials. Shared interfaces preceded the delegated program/worker/frontend implementations; fresh review followed local settlement. [Interface](INTERFACES.md), [review](REVIEW.md), [completion audit](COMPLETION-AUDIT.md), [setup](../README.md).

| Gate / deliverable | Verified evidence |
| --- | --- |
| Build and deployment | [Build provenance](../evidence/build.json), [Devnet deployment](../evidence/deployment-devnet.json): finalized executable and exact onchain bytecode match. The interrupted upload reused one funded buffer; [resumption journal](../evidence/deployment-devnet-buffer.json). |
| Safety and regression tests | **64 tests passed:** 17 local program tests, 11 fresh-review tests, 31 client/worker tests, five Rust tests. [Program TAP](../evidence/program-localnet.tap), [review TAP](../evidence/review-localnet.tap), [refreshed checks](../evidence/checks.json). All typechecks and the production Devnet web build pass. |
| Devnet client money paths | [Client verification](../evidence/verify-devnet.json): finalized Released and Refunded jobs, exact 5,000,000-unit transfers, retained terminal records, signatures and separately recorded SOL fees. |
| Devnet purchase and API-offline refund | [HTTP rehearsal](../evidence/rehearsal-devnet.json): real PNG/WebP, original persisted before approval, buyer-signed download, second-wallet/replay denial, identical file after restart; API process exited and port refused connections before, at and after refund, with zero merchant HTTP calls during refund. |
| Devnet browser flow | [Browser evidence](../evidence/ui-devnet.json): actual signed funding/approval/refund, download after backend restart and page reload, zero browser errors and zero merchant requests during independent recovery; desktop/mobile screenshots and full recordings. |
| Reuse | [Small wallet-client example](../packages/chain/README.md), typechecked and covered by a confirmation-failure regression. Funding, approval and direct refund remain separate buyer actions; the existing program is reused. |
| Demo and submission materials | [113.92-second Devnet demo](../evidence/demo-devnet-draft.mp4), [source hashes and labels](../evidence/demo-devnet-draft.json), [two-minute script](DEMO.md), [submission copy and AI disclosure](SUBMISSION.md). |

## Public Devnet evidence

Program: [`7cW6fScgHCAWBo9YDQEhuS6brFjssJSmomRN11Xa9iKY`](https://explorer.solana.com/address/7cW6fScgHCAWBo9YDQEhuS6brFjssJSmomRN11Xa9iKY?cluster=devnet).

Mock mint: [`4jMjhk5ZyqnED6BtbQwiqNmcuzMJmti83nEPsceUtN7C`](https://explorer.solana.com/address/4jMjhk5ZyqnED6BtbQwiqNmcuzMJmti83nEPsceUtN7C?cluster=devnet), six decimals and no real monetary value.

- Browser [payment release](https://explorer.solana.com/tx/2KoexF5XBk6g66r1rHvSTh9XW71hTycDB5ngYGiwPh4FwaBvpZch5XkHhWbgzpPLQgq8kgJPxWT5en3mDHcBUMoJ?cluster=devnet).
- Browser [API-offline refund](https://explorer.solana.com/tx/Yf3vqNYDdueKTapA9T8TPSANAWJxmSuydXsEPNJKDh3MVaz1h9NdmSnPMWdzLvWt86Kx9a7NWxh3pTrnXhTg9Ah?cluster=devnet).
- [Client transactions and fees](../evidence/verify-devnet.json), [HTTP transactions and process proof](../evidence/rehearsal-devnet.json), [browser jobs and signatures](../evidence/ui-devnet.json).

The browser's actual token balances below are **buyer / vault / merchant**, in mock USDC. SOL fees and account rent are separate.

| Path | Before funding | Funded | Settled |
| --- | --- | --- | --- |
| Approve | 85 / 0 / 15 | 80 / 5 / 15 | 80 / 0 / 20 |
| Timeout refund | 80 / 0 / 20 | 75 / 5 / 20 | 80 / 0 / 20 |

The first client attempt released normally, then hit an RPC 429 before funding its refund job. [Historical terminal release](../evidence/verify-devnet-first-attempt.json). Request pacing and bounded cooldown handling were added, reviewed and regression-tested; the subsequent full client, HTTP and browser runs passed. No stranded funded deposit is known from these runs.

## Scope and remaining participant actions

**No technical blocker remains.** The five Devnet SOL arrived and deployment funding is resolved; [current network/balance observation](../evidence/devnet-status.json). The scripts used disposable wallets and explicitly labeled mock USDC.

Browser signing used an injected disposable test wallet, with private signing confined to Node. Actual Phantom extension approval/reconnect remains a manual check. The Devnet browser recovery opened after its 75-second deadline, so this run proves after-expiry recovery; the local browser run and boundary tests cover early-refund gating.

The video is silent and explicitly labels Devnet, injected wallet, mock tokens and checkout playback at 3.80x; recovery remains at 1x. Its captions identify the saved original and the actual API exit/refused port/zero requests. Review it, personalize the learning/AI disclosure and optionally add narration before publishing/submitting the final version. The participant owns MLH login, team/registration confirmation, final video publication and the actual submission.

Keep the earlier published schedule: initial Sunday November 8 at **7:00 a.m. Pacific**, final **8:45 a.m. Pacific**. The portal observation lists 10:00 a.m.; organizer clarification is needed before relying on that later time. DeFi is the target track; Best Beginner eligibility remains conditional.

Known prototype limits: upgradeable program, centrally minted mock token, merchant/storage-dependent delivery, one worker per storage directory, retained job/vault rent and locked accidental surplus. Local explorer links in historical artifacts need the local ledger; use the Devnet links above for public proof.

All owned Devnet worker/Vite processes have terminal exits and their ports refuse connections. [Cleanup observation](../evidence/cleanup-devnet.json). Disposable keys and private rehearsal files remain ignored under `.local/`.
