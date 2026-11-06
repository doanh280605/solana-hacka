# Solana hackathon execution prompt

Place this file in the root of a fresh Codex workspace. Set the lead session to xhigh. Once hacking opens, paste the line below into that session. Attach this file if the session cannot access the workspace copy.

```text
/goal Read Solana_Hackathon_Execution_Goal.md and own the build from setup through a submission-ready demo. Deliver a reproducible Solana Devnet checkout where a buyer can fund a real digital job, approve it to release test USDC, or recover the deposit directly from the program after a failed job times out. Coordinate the authorized subagents, integrate in stages, and verify the completion checklist. If blocked, finish independent work and leave an evidence-backed handoff with the exact action I need to take.
```

## Product and scope

Build a refundable stablecoin checkout for small apps that sell automated digital work. The reference merchant converts a PNG into WebP. The buyer deposits 5 test USDC into a vault, reviews a watermarked preview, and approves to release the payment and unlock the full result. If the worker stalls or the buyer never approves, the buyer can reclaim the deposit after a visible deadline, even while the merchant API is offline.

The judge should be able to see where the money is at every step. The program decides who can move it, when they can move it, and which wallet receives it. The merchant backend stores files and runs the conversion. Digital delivery depends on the merchant and its storage. The demo should show the result already persisted before approval, and allow an approved buyer to recover download access on reconnect while storage is available.

Target DeFi. Treat Best Beginner as conditional on the organizers confirming how first-time Solana builders count. Verify the submission portal and deadlines against the current MLH event page or newer organizer instructions. At the time of writing, the public schedule lists Friday Nov 6 at 9 a.m. Pacific for hacking, and Sunday Nov 8 at 7 a.m. Pacific for initial submission and 8:45 a.m. for final submission, through MLH Challenges. Plan to have a recorded demo and draft submission Saturday night. The user handles final submission and any publishing that requires account access or changes visibility. Record which AI tools were used for the submission.

## Lead and subagent responsibilities

- The lead owns scope, public interfaces, the integration branch, milestone gates, and user updates. Inspect the workspace and existing instructions first. Write a short shared interface note covering the job states, transaction API, job ID format, and worker API before implementation fans out.
- Spawn up to three implementation subagents if supported. Give each a disjoint set of files or an isolated worktree. The program agent owns the Rust/Anchor program, token account constraints, and program tests. The worker agent owns uploads, image conversion, persistent result storage, the offline/failure switch, and download authorization. The frontend agent owns wallet UX, the checkout and independent recovery client. The lead owns shared configuration, the generated client interface, and merges. Resolve changes to shared types through the lead.
- Let worker and frontend agents scaffold against the interface while the program agent proves the money flow. Use fixtures during development. Wire the frontend to real program calls before scoring any flow as complete. If subagents are unavailable, carry out the same workstreams sequentially.
- Once the program compiles and both settlement paths run locally, delegate a fresh review of the contract and client integration. Ask the reviewer to try to break the stated rules, using commands or test cases and concrete evidence. The lead decides and applies fixes, then reruns the affected checks.
- Each subagent reports the files or branch changed, behavior working, commands run and results, failing checks, and dependencies on other agents. Require a small handoff at each milestone. Limit concurrent work to what the lead can integrate.

## Tools and setup

- Use Rust + Anchor for the program and TypeScript for the client, merchant app, and scripts. Default to a small React or Next.js UI, a Node image worker, and local persistent storage for the reproducible demo. Choose the simplest project layout the available starter supports.
- Inspect available skills and tooling first. Use existing relevant Solana or Anchor, frontend, and browser QA skills if available. If the session supports skill installation and an official Solana skill would address a concrete gap, install only that vetted skill and read its instructions. Otherwise use the official references below. A missing skill is never a reason to stall the build.
- Check Node, Rust, Solana and Anchor versions and pin a compatible set of dependencies. Use the same client stack as the chosen Anchor starter and confirm compatibility before adding packages. Keep the program ID and generated IDL aligned across the app, script, and deployment.
- Run locally first, then deploy to Devnet using disposable test wallets. Use a supported Devnet test mint or a clearly labeled mock stablecoin mint if funding is a blocker. Keep wallet secrets out of git and UI code. If the faucet, RPC, or Devnet deploy is blocked, finish and record the local run, log the exact blocker, and mark Devnet evidence as outstanding.

## The contract and the app

1. **Fund.** Derive a unique job PDA from the buyer and job ID, and bind the buyer, merchant, mint, amount in integer base units, and chain-time expiry at creation. A program-controlled vault holds the deposit. Create the job and move tokens atomically. Keep the job record after settlement so the same ID cannot be reinitialized to replay the order. For the demo, allow one configured mint and the matching SPL Token Program. Validate token authorities, expected destination accounts, positive amount and valid deadline. A duplicate fund request must not transfer funds again. The worker independently checks that the finalized job matches its quote before processing it.
2. **Approve.** Only the original buyer can sign approval of a funded job before expiry. Release exactly the recorded amount to the recorded merchant and record `Released` in the same transaction. The checkout shows approval once the preview is available. The program enforces buyer consent and payment rules, while the app determines when the file is ready.
3. **Refund.** The original buyer can refund a funded job at or after expiry. Pay only the recorded buyer and record `Refunded` in the same transaction. The recovery client accepts a job address or link, reads Solana directly, and builds the refund transaction with the connected wallet. It must run with the merchant worker and API stopped. This is a buyer-initiated transaction.
4. **Process and deliver.** Upload one small PNG, persist the converted file before showing the preview, and provide a deterministic test switch that can stall the job. Before serving the original WebP, verify that the purchase is released, matches the stored order and file, and that the requester controls the buyer wallet. Use an expiring signed challenge or a session established with a wallet signature. Recover status after reload from the chain plus durable job metadata. Keep original files and private links out of public onchain state.

## Build gates

| Gate | Show the lead this evidence before moving on |
| --- | --- |
| 1. Program | Build succeeds. Local script funds one job and approves it, then funds a second job and refunds it at expiry. Record before/after vault, buyer, and merchant token balances. Use short deadlines for rehearsal. |
| 2. Product | A real PNG becomes a downloadable WebP. A wallet can pay through the normal UI, approve a preview, and regain download access after a reload. A second run can intentionally stall and recover through the independent client with the merchant API stopped. |
| 3. Devnet and submission | Replay both paths with test tokens on Devnet. Capture real transaction IDs and explorer links, the deployed program ID, and any remaining limitations. Rehearse the demo from a clean start and prepare the submission materials. |

Test wrong signer, wrong mint or destination, early refund, approval after expiry, duplicate funding, and repeated or competing terminal actions. In each rejected case verify both job state and token balances, accounting for network fees separately. Test backend restart or reload where it affects order recovery, and verify a second wallet cannot unlock someone else's file. Prefer a reproducible script and a few focused tests over a broad suite.

## Time and scope cuts

Prioritize the local payment and refund loop in the first build block. Start a Devnet deployment attempt as soon as the local program passes so funding and version problems surface early. On Saturday, prioritize a full rehearsal before visual polish. If time gets tight, cut additional job types, analytics, and reusable SDK packaging. Keep one working conversion and the independent refund. If you finish early, add one documented second merchant integration or a small SDK example to show reuse without duplicating the program.

## Completion and handoff

- Deliver working source, example configuration, pinned dependencies, a README with exact setup/run commands, and a repeatable local demo. Include Devnet instructions and evidence when available.
- Prepare a short demo script that shows the success path and then the failure path. Start with the buyer's problem, show the funds in escrow, stop the merchant API, and prove the buyer got the deposit back. Show the real transaction and state changes.
- Report after each gate and at meaningful blockers. Include completed work, tested behavior, current state, next action, and remaining time risk. Ask the user only for a concrete decision or access step that actually blocks progress. Specify exactly what the user should do, where, and what signal proves it worked. Continue independent tasks while waiting.
- At the end, report completed goals, files and commands, program ID, transaction links, test results, open blockers, and what the user must do before submission. Distinguish local results from Devnet results and verified behavior from assumptions. Mark the goal complete only when the core evidence exists.

## Reference links

- [MLH event and schedule](https://events.mlh.com/events/15200-solana-hackathon)
- [MLH Challenges event](https://www.mlh.com/events/solana-hackathon)
- [MLH standard rules](https://github.com/MLH/mlh-policies/blob/main/standard-hackathon-rules.md)
- [Anchor account constraints](https://www.anchor-lang.com/docs/references/account-constraints)
- [Anchor token transfers and PDA signing](https://www.anchor-lang.com/docs/tokens/basics/transfer-tokens)
- [Anchor testing with LiteSVM](https://www.anchor-lang.com/docs/testing/litesvm)
- [Solana payment quickstart and Devnet funding](https://solana.com/docs/payments/quickstart)
