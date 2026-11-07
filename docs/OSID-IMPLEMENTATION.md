# osid implementation and handoff

Updated November 07, 2026, 19:55 UTC. Branch `integration/osid-v2`; clean baseline `eca59b5beb295e9d02fe3f57249b62be09b458f1`. The user's osid scope supersedes the original completed Holdfast goal. Preserve historical evidence, keys, ledgers and unrelated changes.

## Checklist

- [x] Inspect checkout/instructions/baseline/listeners and preserve V1 fallback.
- [x] Agree schemas, routes, states, canonical hashes/errors in INTERFACES.md before parallel work.
- [x] Frontend agent owns apps/web: branding, landing/sample, signed sessions, workspace, verified review/download, receipts and recovery.
- [x] Service agent owns apps/worker: runtime AI, interpreted specifications/quotes, durable attempts/private artifacts/ZIP, auth and delivery.
- [x] Protocol agent owns programs/checkout and packages/chain: additive V2, SDK/IDL and tests, unchanged V1 ABI.
- [x] Lead owns root config/lock/scripts, deployment, integration/evidence and docs; serialized stateful chain operations.
- [x]90 unit +10 Rust, four typechecks/build/all nine aggregate gates;39 actual local-program tests.
- [x] Local/Devnet fixture quote-to-download, restart persistence and API-offline browser refund with zero merchant requests.
- [x] Devnet upgrade/config/genesis/complete bytecode hash and V1 compatibility independently verified.
- [x] Actual live OpenAI spec/copy/image edits, immutable submissions and independently reviewed accepted output.
- [x] Five funded live attempts refunded exactly, including Funded and Submitted; one post-read failure reconciled without another transaction.
- [x] Independent security/content review; material code findings resolved; host/execution limitation recorded.
- [ ] Successful real AI approval, released private download, reload/restart delivery and fresh API-offline browser refund in one eligible run.
- [x] Current evidence/setup/limits/demo/submission disclosure updated; managed live-configured local preview available.
- [ ] Core goal complete. Do not mark complete while the preceding live gate is pending.

## Current operating condition

The provider key is configured in ignored `.env`; never print or replace it. Defaults: `gpt-4.1-mini`, `gpt-image-1.5`. User was asked once asynchronously to keep this Mac awake, lid open and online for an uninterrupted ten minutes. **No new paid attempt while that required condition remains unanswered.** Continue unaffected documentation, preview and source handoff. A temporary task-owned `/usr/bin/caffeinate -i -s -t21600` assertion is recorded in `.local/osid-awake.json`; its automatic limit is six hours. Observed wall-clock gaps persisted, so do not claim it established the cause or solved the issue. Stop only its verified owned PID when no longer needed.

Both rejected real packs demonstrated why byte checks cannot approve content: first invented durability/freshness; second reassigned jar mass to wax and leaked photo directions. Third was a conservative grammar false positive before image generation. Fourth complete pack passed independent review for `5Fo7ZG6CTgcjW85fPAUt8VJgAxwkz7rdHgnx8JaGztok`, result `3a36c20f89a47b32c45a2b9fcb0f7f2889c553cd91d1e54aa43e32f1663ab38d`, but RPC cooldown prevented any approval signature and expiry subsequently passed. Fifth expired unfunded. Sixth image attempt is uncertain, with no result or provider identifier; preserve it for manual reconciliation, never blindly POST again. All five actual deposits are now Refunded. See STATUS.md table for immutable evidence/receipts and OSID-REVIEW.md for independent checks.

Copy fixes: listing input contains only agreed facts/limits; complete phrases, measurement subjects, qualifiers and bounded benefit checks; worked example; temperature 0 only on GPT-4.1 Mini aliases/snapshots. These are conservative guards, not semantic proof. Historical committed delivery verifies original hashes and is never rewritten under a new policy.

RPC fixes: frontend chain polling every 15 seconds, order polling every 12 seconds, one validated token-balance batch with exact u64 decoding, no overlapping epoch reads. Rehearsal balance snapshots also batch; runner waits for actual wallet signature before polling settlement. Money builders/contract safety and same-signed-transaction bounded retries remain unchanged.

## Durable locations and process rules

Program `7cW6fScgHCAWBo9YDQEhuS6brFjssJSmomRN11Xa9iKY`; mock mint `4jMjhk5ZyqnED6BtbQwiqNmcuzMJmti83nEPsceUtN7C`; six decimals, exact 5,000,000-unit price. SBF 467120 bytes, SHA-256 `b59f0a228e24782e869316201faf17c4e39a7111082065fc42a51d418122e2a0`. No protocol source changes since actual39 local tests/deployment. V1 fallback hash record remains in evidence.

Private unique runs/stores are under `.local/osid-ui-devnet-*`; rejected/unfunded/interrupted/uncertain original reports/captures were separately archived there before public filename reuse. Never mutate old order/result files. Provider request/response/attempt IDs are durable. Five timeout-refund reports are public `evidence/osid-live-*-refund*.json`; no private key or credential belongs there.

Managed live preview: http://localhost:5173/ plus /demo,/app,/recover; API 8787. Exact owned PIDs/entries/logs are in `.local/osid-preview.json`; stop with `npx tsx scripts/preview.ts stop`, restart `npx tsx scripts/preview.ts start`. Preview order storage is separate from rehearsals. Do not run Vite canary tests, alter app env/config or start a conflicting rehearsal while a browser wallet action is active. Run one worker per storage directory. Do not kill generic Node/Chrome processes.

Local validator uses isolated `.local/ledger-osid-v2`; do not reset historical ledgers/keys. Project Cargo registry metadata was restored as real files with469 preserved-byte matches. Aggregate command: `CARGO_NET_OFFLINE=true CARGO_TARGET_DIR=/private/tmp/osid-protocol-host-target npm run check:osid`. Current source changes after that aggregate are cleanup-only CLI extensions, separately root-typechecked; rerun appropriate checks if new source changes occur.

## Required continuation

When the user confirms uninterrupted host availability: stop only the managed preview; run `npx tsx scripts/osid-ui-rehearse.ts devnet --review-gate` with normal 1800-second deadline. Use a fresh job; never rebind an expired result or retry an uncertain image. The independent reviewer may inspect actual new bytes/images/copy and the lead's recorded finalized Submitted snapshot, then atomically write its private decision bound to the exact run/job/hash before expiry. This is agent test review, not external human attestation. Fresh independent RPC receipt checks follow terminal settlement. Buyer keys remain in Node callbacks, never browser/worker.

The runner's `--resume=RUN_ID` only permits the same already-reviewed unexpired Submitted job before any approval signature, matching config/storage/result and preserving attempts/funding. It refuses expiry before starting servers. No successful resumption is claimed yet.

After a passing live run: inspect exact release/token deltas, downloaded seven-file manifest bytes, identical reload/restart output/attempt IDs, separate API-offline refund/zero requests and desktop/mobile captures. Generate `npx tsx scripts/osid-demo-video.ts devnet` only from a passing live report; never fabricate one. Refresh docs/status/audit, restore live preview, commit/push normally and mark goal complete only after all required gates pass.

No paid plan/terms/billing commitment, mainnet spend, production publish, default-branch merge, force push or entry submission. Official MLH schedule checked November 6: November 8 initial 07:00 Pacific, final 08:45 Pacific. Provider performance bonds are a separate follow-up in ARCHITECTURE.md; arbitration/marketplaces/identity registries/autonomous spending remain deferred.

## Additional skills requested by the user

Installed and verified in the current host’s user-scoped Codex skills directory: `solana-dev` from `solana-foundation/solana-dev-skill`, plus official OpenAI `playwright` and `security-best-practices`. They become discoverable on the next turn. These references support focused future Solana/browser/security work; their generic modern-stack recommendations do not authorize replacing this verified pinned toolchain, program addresses or V1 ABI. Installation changed no repository dependencies or deployment. Current managed preview additionally passed all eight desktop/mobile route checks with direct Refunded-state recovery and zero merchant requests.
