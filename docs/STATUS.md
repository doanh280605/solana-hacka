# osid execution status

Updated November 08, 2026. Branch `integration/osid-v2`, based on verified Holdfast V1 `eca59b5`.

**Core goal incomplete: the live AI quote-to-approved-download gate has not passed.** Credentials are configured. Real runtime specification, listing and image-edit requests are verified, and one complete pack passed content/integrity review. RPC interruption prevented its approval before signing, then its immutable deadline passed. Later host/execution delays expired an unfunded quote and left a separate image attempt uncertain. The user was asked to keep the Mac awake, lid open and online for an uninterrupted ten minutes before another paid attempt. No fixture is counted as live AI.

## Implemented and checked

| Gate | Actual evidence |
| --- | --- |
| Product | osid landing, clearly labeled no-wallet sample, signed wallet sessions, integrated workspace, exact-result buyer approval, verified private ZIP and independent V1/V2 recovery. |
| Pack | 1600×1600 hero; social exports at 1080×1080, 1080×1350 and 1080×1920; title 80 / description 1200 / five bullets 180; validation, manifest and seven-file ZIP. Four review previews are separately committed. |
| Checks | All nine aggregate gates pass: 105 unit,10 Rust, four typechecks, production build and whitespace. [Report](../evidence/osid-checks.json). Final login-smoke harness changes separately pass root typecheck; [source/check provenance](../evidence/osid-final-source.json). |
| Wallet login | Native SIWS with explicit `solana:devnet`, strict returned account/public-key/message/signature verification, fallback only when native is absent, safe unused-nonce migration and network guidance. Seven real HTTP/browser login cases pass using disposable injected wallets, including restore/logout, cancellation and tampered output. [Report](../evidence/osid-wallet-auth.json). Actual Phantom retry is pending. |
| Actual local program | 39 passed:17 V1,11 V2,11 independent cases. [Report](../evidence/osid-program-localnet.json). Program source is unchanged since these checks. |
| Deployment | Devnet finalized upgrade, exact 467120-byte executable SHA-256 `b59f0a228e24782e869316201faf17c4e39a7111082065fc42a51d418122e2a0`, correct genesis/config, unchanged V1 layouts/terminal decoding. [Deployment](../evidence/osid-deployment-devnet.json). |
| Local application | Full HTTP/browser fixture purchase, exact settlement, private verified repeated download, auth/download replay and other-wallet denial, restart persistence, actual API-stopped refund. [HTTP](../evidence/osid-rehearsal-localnet-fixture.json), [browser](../evidence/osid-ui-localnet-fixture.json). |
| Devnet application | V2 fixture fund/submit/approve, exact 5,000,000-unit merchant release, identical438,609-byte manifest-verified ZIP after restart/reload; separate refund with API exited before expiry, connection refused before/at/after, zero recovery merchant requests. [Fixture browser report](../evidence/osid-ui-devnet-fixture.json). |
| Runtime AI | Actual OpenAI interpretation/copy/source-image edits with persisted request/response identifiers; no fixture fallback. [Provider access](../evidence/osid-provider-access.json), [accepted result and RPC interruption](../evidence/osid-live-ui-rpc-interruption.json), [expiry](../evidence/osid-live-ui-rpc-expired.json). No live Released/download success claimed. |
| Independent review | Authorization, settlement, recovery, AI attempts, auth, storage, complete ZIP/preview binding, dependencies, process handling, Vite private-file boundary and actual live content reviewed. Material code findings resolved; required live lifecycle remains pending. [Review](OSID-REVIEW.md). |

Browser money actions used a disposable injected test-wallet harness. **Actual Phantom extension behavior is unverified.** Agent/operator content review is not external human quality attestation. Hashes bind terms and bytes, not subjective quality or truth.

## Live attempts and reconciled deposits

| Attempt | Outcome | Refund evidence |
| --- | --- | --- |
| First real pack | Image identity/integrity passed; review rejected invented durability/freshness benefits. Frozen Submitted result retained. [Record](../evidence/osid-live-ai-rejected.json). | [Original-buyer Submitted refund](../evidence/osid-live-rejected-refund.json). |
| Second real pack | Review rejected invented wax net weight and photographic-direction leakage. Frozen Submitted result retained. [Record](../evidence/osid-live-ai-rejected-2.json). | [Submitted refund](../evidence/osid-live-rejected-refund-2.json). |
| Third | Conservative grammar/measurement-clause false positive on factual connecting prose; failed before image/submission. [Record](../evidence/osid-live-ai-rejected-3.json). | [Funded refund](../evidence/osid-live-rejected-refund-3.json); post-read failure reconciled using its original finalized signature, no replacement transaction. |
| Fourth | Exact fact copy, product identity, all artifacts/previews and231,796-byte stored ZIP accepted. RPC cooldown blocked approval before signing; deadline subsequently passed. | [Expired Submitted refund](../evidence/osid-live-interrupted-refund.json). |
| Fifth | Quote expired during observed execution delay before any recorded funding signature. No funded purchase or result claimed. [Record](../evidence/osid-live-unfunded-expired.json). | None required by the recorded run. |
| Sixth | Live spec/copy completed; image completion uncertain with no result/artifacts. Attempt retained, no blind regeneration. [Record](../evidence/osid-live-ai-uncertain.json). | [Funded refund](../evidence/osid-live-uncertain-refund.json). |

**All five funded live attempts are Refunded, with exact 5,000,000-unit buyer returns and unchanged merchant balances.** Deterministic validation did not authorize unsupported content. New live copy requests exclude the raw brief/photo/image direction; exact fact phrases and whole measurement subjects are checked. A worked example and model-scoped temperature 0 align generation with this conservative grammar. Historical frozen delivery verifies original bytes without applying a later editorial policy.

Actual accepted-but-expired pack: [desktop](../evidence/screenshots/osid-live-accepted-expired-review-desktop.png), [mobile](../evidence/screenshots/osid-live-accepted-expired-review-mobile.png). These are actual runtime AI previews, not proof of release/download. [Observed host-delay record](../evidence/osid-host-delay.json). The exact cause of wall-clock gaps is unproven; temporary sleep assertions did not establish uninterrupted execution.

## Local preview

- Landing: http://localhost:5173/
- Labeled sample: http://localhost:5173/demo
- Workspace: http://localhost:5173/app
- Independent recovery: http://localhost:5173/recover
- Worker: http://localhost:8787/health

Mode is **live on Devnet**, with an existing configured provider credential and empty preview order storage. Starting the preview creates no order or paid AI request. The tested login repair was loaded November 8 at 08:43 UTC: web PID54544; worker PID54460. Exact entries/logs are in ignored `.local/osid-preview.json`; logs are `.local/osid-preview-web.log` and `.local/osid-preview-worker.log`.

Stop only these verified processes with `npx tsx scripts/preview.ts stop`; restart with `npx tsx scripts/preview.ts start`. Use `start --fixture` only for explicitly labeled development fixtures. Do not run Vite canary tests or edit app environment/configuration during wallet transactions. The prior [read-only preview checks](../evidence/osid-preview.json) passed all eight desktop/mobile route cases, with no page errors or horizontal overflow and zero recovery merchant requests. The current login smoke separately verifies the repaired native/fallback paths and captures desktop/mobile sign-in with no new orders, AI calls or money actions.

## Remaining gate and boundaries

After the required uninterrupted operating condition is available: stop the managed preview, run `npx tsx scripts/osid-ui-rehearse.ts devnet --review-gate`, inspect the exact new submitted result before approval, verify release/download/restart and the separate API-offline refund, then restart the live preview. Use unique jobs. Never regenerate an uncertain image request or extend a recorded deadline. An unexpired interrupted reviewed job can use the runner's exact `--resume=RUN_ID` path only before any approval signature; it reuses storage and refuses expiry. No completed run is currently claimed for that option.

The existing108-second [Devnet fixture walkthrough](../evidence/osid-demo-devnet-fixture.webm) remains accurately labeled, with [source/caption hashes](../evidence/osid-demo-devnet-fixture.json). It is a silent screenshot presentation, not a continuous real-time or Phantom recording. No successful live walkthrough is fabricated.

One worker owns each storage directory. Files depend on storage/backups. The program is upgradeable and unaudited; mock tokens have no monetary value; rent/surplus remain locked. Refunds require the original buyer's transaction. No permanence, cryptographic fair exchange, arbitration or provider bond is claimed. Remaining transitive advisories and assessed paths are in the independent review.

The normally pushed feature branch preserves V1 evidence and commit `eca59b5`; no default-branch merge, force push, mainnet spending, production publish or hackathon submission. Compare `git rev-parse HEAD` with `git ls-remote origin refs/heads/integration/osid-v2` for the handoff revision. [V1 binary preservation](../evidence/osid-baseline-preservation.json).

Official MLH schedule checked November 6: November 8 initial 07:00 Pacific, final 08:45 Pacific. [Official schedule](https://events.mlh.com/events/15200-solana-hackathon). Nothing was submitted.
