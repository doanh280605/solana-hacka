# Execution status

Updated November 6, 2026. **Local gates pass. Devnet is blocked on test SOL. The full goal remains active.**

## Done

Built the Rust/Anchor checkout, shared generated-IDL TypeScript client, durable PNG-to-WebP merchant, wallet checkout and independent recovery page. Source, example configuration, exact npm/Cargo locks, setup/deployment scripts, live verification, browser rehearsal, demo script and submission draft are present. Integration branch: `integration/holdfast`.

Delegation followed the requested stages: shared interfaces first; disjoint program, worker and frontend implementations; real-chain product/browser integration; then a fresh adversarial reviewer. The lead integrated the results and fixed the review finding. [Review report](REVIEW.md).

| Gate / check | Current authoritative evidence |
| --- | --- |
| Program build | [Build provenance](../evidence/build.json); Anchor-generated IDL; executable local program's bytecode matches the compiled artifact in [deployment evidence](../evidence/deployment-localnet.json). |
| Local program safety | [Program TAP](../evidence/program-localnet.tap): 17 tests, 33 rejected actions, no failures/skips. Fresh initializer authorization, token constraints, exact settlement, expiry, replay and terminal state checks. |
| Submitted failure rollback | [Fresh review TAP](../evidence/review-localnet.tap): 11 tests passed. Ten failed transactions actually landed; job/token/vault/buyer rent unchanged, 10,000-lamport network fees recorded separately. Includes approve+refund and refund+approve in one transaction. |
| Client and worker tests | [Clean install](../evidence/clean-install.json) from pinned lock, followed by [checks](../evidence/checks.json): 24 tests, five Rust tests, all workspace typechecks and production web build pass. Worker tests use explicit chain fixtures; live proof is below. |
| Real local money paths | [Client verification](../evidence/verify-localnet.json): finalized fund/release and fund/refund, exact integer token balance changes, retained job records, transaction signatures and explorer links. |
| Real product / stopped API | [Product rehearsal](../evidence/rehearsal-localnet.json): PNG upload, original persisted before preview, signed buyer download, wrong-wallet denial, single-use signatures, identical download after worker restart, deterministic stall, and refund while the owned API process had exited and the port returned `ECONNREFUSED`. |
| Browser product / stopped API | [Browser rehearsal](../evidence/ui-localnet.json): normal UI signs actual local transactions, download survives backend restart and browser reload; independent recovery signs the refund with **zero merchant requests** and API offline. Desktop/mobile screenshots and raw videos are under `evidence/`. Browser signing used a disposable injected test wallet; the Phantom extension was not manually tested. |
| Fresh review | One low-severity challenge-eviction availability issue found, fixed, and verified with live regression. No high/medium custody, consent, destination, expiry, replay or private-file disclosure finding in the reviewed scope. |
| Submission preparation | [97-second silent local demo draft](../evidence/demo-localnet-draft.mp4), [demo script](DEMO.md), [submission draft and AI disclosure](SUBMISSION.md), [portal observation](../evidence/event-portal.json). The video labels localnet and the injected test wallet; final Devnet video, publication and submission remain outstanding. |

## Program and transaction evidence

Program ID: `7cW6fScgHCAWBo9YDQEhuS6brFjssJSmomRN11Xa9iKY`.

Mock mint: `4jMjhk5ZyqnED6BtbQwiqNmcuzMJmti83nEPsceUtN7C` (six decimals; not real USDC).

The address is **deployed locally; Devnet deployment is not yet verified**. Local explorer links need this machine's live RPC/ledger and are not public Devnet transactions.

- Browser release: `2din2GqKL5EkcusLcm4MQr6FDxMBURF3ASerrpZ8J2uKWCV5wTTMAZSeZUK4Qk96H2KMH4gpTEL6DtZUNPi8MmH9`.
- Browser API-offline refund: `4SKwkKWwfVxtJNRpKHa5CANiKtP9ffpCp9zZfvzCxGGwR4X16aSZ8jThhnZVTwzQyMh9v5LBoPPYxRPVndqNrAwE`.
- Full transaction links, before/funded/after balances, job addresses and API-offline process evidence: [browser evidence](../evidence/ui-localnet.json) and [product evidence](../evidence/rehearsal-localnet.json).

## Blocked / exact user action

The Devnet RPC works, but its airdrop endpoint returns **410: faucet closed**. The disposable deployer still had **0 SOL** in the latest [live Devnet observation](../evidence/devnet-status.json). [Deployment attempt and error](../evidence/deployment-devnet-blocked.json). No Devnet release/refund signatures exist yet.

Fund **`C7WiJfYa9epa1Bdt92txtWXVtHFErQXN23CE2Fyiz4SW` with 5 Devnet test SOL** at [faucet.solana.com](https://faucet.solana.com), or transfer existing Devnet test SOL to that address. Do not send mainnet SOL or share a wallet secret. The current initial-deployment estimate is about 4.1 test SOL.

Success signal: `npm run status:devnet` reports `fundingReady: true`. The lead can then continue without another approval:

```sh
npm run deploy:devnet
npm run verify:devnet
npm run rehearse:devnet
npx tsx scripts/ui-rehearse.ts devnet
```

After those runs, update this status from the actual Devnet evidence and record/edit the final demo. The pending Devnet step is the main schedule risk; no local result is being counted as Devnet completion.

## Before submission

- Manually confirm Phantom extension signing and reconnect on the intended network, using the public-wallet funding command in the README.
- Review/edit the recorded demo to at most two minutes, begin with the hackathon name, and add the participant's narration/learning details. Raw local captures document real behavior but do not prove Devnet.
- Log in to MLH, confirm registration/team details and the submission fields, publish the source and final video, and submit through the participant's accounts.
- Use the earlier schedule: initial Sunday November 8 at 7:00 a.m. Pacific; final 8:45 a.m. Pacific. The portal currently lists 10:00 a.m. Pacific, so organizer clarification is still needed before relying on the later time. Keep Best Beginner conditional; DeFi is the target track.

Known prototype limits: upgradeable program, disposable centrally minted test token, merchant/storage-dependent delivery, one worker per storage directory, retained account rent and accidental vault surplus. [Setup and commands](../README.md).

Owned UI/API test processes and the local validator were stopped after verification. The ledger, disposable keys, and private rehearsal files remain under ignored `.local/`. Restart with `npm run validator`, `npm run dev:worker`, and `npm run dev:web` to work locally; the recorded demo can be viewed without these processes.
