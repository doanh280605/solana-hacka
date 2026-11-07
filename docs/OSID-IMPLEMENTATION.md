# osid implementation and handoff

Started 2026-11-06 from clean `eca59b5beb295e9d02fe3f57249b62be09b458f1`, branch `integration/osid-v2`. User's osid prompt supersedes the original execution scope. Historical Holdfast evidence stays labeled V1. Lead owns root/docs/scripts/deploy/evidence. Shared agreement: `docs/INTERFACES.md` V2 section.

## Checklist

- [x] Inspect checkout, instructions, baseline source/docs, environment and existing listeners.
- [x] New integration branch, preserve clean V1 baseline.
- [x] Write V2 schema/routes/commitment/lifecycle/ownership agreement before implementation.
- [x] Frontend: landing/demo/sign-in/V2 workspace/preview/validation/receipts/V1+V2 recovery implemented. Committed preview-integrity fix reviewed and tested.
- [x] Service: real AI adapter, spec quotes, durable attempts/artifacts/ZIP, auth/session/private delivery implemented. Live execution remains a separate gate.
- [x] Protocol: additive V2 escrow + SDK/IDL + local/host/client tests, preserve V1.
- [x] Root setup/config and dedicated provider signer, dependencies/lockfile.
- [x] Integrated typecheck, 74 worker/client/web unit tests, 10 Rust tests, production build.
- [x] Actual local program: 39 passed (17 V1, 11 V2, 11 review). Independent review found and verified fixes; final preview regression pending.
- [ ] Live AI quote -> funding -> edit/copy -> submission -> approval -> manifest-verified download.
- [ ] Safe Devnet upgrade/deploy with disposable funds; new release/refund evidence.
- [ ] API actually stopped; direct recovery zero merchant requests, both pending states covered.
- [ ] Browser desktop/mobile evidence, labeled test-wallet harness, preview available.
- [ ] README/env/docs/status/architecture/provider/demo/submission/AI disclosure updated.
- [ ] Independent review resolved; final regression gates.
- [ ] Commit, normal push and remote confirmation.

## Baseline observations

- Git clean, exact verified commit; current configuration Devnet, expected program/mint, six decimals and 5,000,000-unit quote.
- Existing listener inventory initially showed node PIDs 93963/93964 on 8787/5173; subsequent process lookup/HTTP did not find them. Reinspect before starting replacements.
- No provider credential in current env/root env. Stripe Projects CLI 1.45.0 authenticated, no project initialized; catalog search OpenAI returned zero. No billing/TOS/provisioning action taken. Asked user once asynchronously to configure existing key; live verification pending.
- Browser computer-use host unavailable at initial inspection; established repository browser harness remains available to investigate.
- Current UTC checked with clock tool. Official MLH page fetched 2026-11-06: Sunday Nov 8 initial 07:00 Pacific, final 08:45 Pacific. Source https://events.mlh.com/events/15200-solana-hackathon . Target required work before Saturday-night feature freeze; no stretch work blocks core gates.

## Delegation

Implementation agents receive disjoint ownership and interface agreement. No root lock/deploy/stateful rehearsal mutations by agents. Each returns tests, files, integration requirements and risks. Lead later assigns separate independent review slot.

## Current handoff (2026-11-06 23:44 UTC)

- New SBF artifact built, 467120 bytes, SHA-256 `b59f0a228e24782e869316201faf17c4e39a7111082065fc42a51d418122e2a0`. Host Rust 10 passed; IDL V1 entries unchanged. Local finalized deployed bytecode independently matched.
- Broad regression before the final preview change: 65 worker/client tests, all TypeScript checks and production frontend build passed. Local 39 actual program tests passed. Evidence is under `evidence/osid-*`.
- Local HTTP fixture rehearsal completed quote/fund/provider submit/buyer approval/verified ZIP, persisted sessions and outputs after restart, login/download replay rejection and other-wallet denial. Separate timeout job refunded after the owned API process exited, with exact token balances. This is fixture AI, not the live gate.
- Desktop and mobile landing/review rendering inspected. Corrected Chrome repaint capture artifact. Full browser purchase/approval/verified download/reload passed; separate recovery is rerunning after a harness label mismatch (5 versus 5.00), without changing product behavior.
- Independent review resolved displayed-copy/validation binding, full browser ZIP verification, decoder dependency exposure and FIFO generation starvation. All four preview byte sets are committed, verified in-browser and covered by independent regressions. Browser testing additionally found and fixed credentialed public-config CORS; focused origin/query tests pass. Managed preview startup/stop checks were hardened for both loopback families and inspection failures.
- Devnet upgrade has not yet run. The disposable deployer has enough observed Devnet SOL for one bounded upload; buffer key will persist so an interrupted upload resumes the same buffer.
- macOS iCloud evicted files during verification. The project was pinned Keep Downloaded, dependency bytes were restored with a fresh locked install, original secrets were preserved, and V1 artifacts/source remain backed up. Current validator uses isolated `.local/ledger-osid-v2` and cloned public Devnet mint, without needing the evicted legacy mint key.
- Live AI remains blocked by missing `OPENAI_API_KEY`. Asked once through asynchronous clarification. No billing commitment was created. Complete unaffected checks, documentation and deployment; never label fixture evidence as live.

## Risks and follow-up

Live provider credentials are required; fixture AI does not complete the goal. Storage remains a delivery availability dependency. Program remains upgradeable and unaudited; mock tokens only. Provider performance bonds are deferred: a future provider deposit could penalize missed measurable commitments, with separate economics/withdrawal/dispute design. Bonds do not prove subjective output quality and are outside this build.

Final aggregate command: `CARGO_NET_OFFLINE=true CARGO_TARGET_DIR=/private/tmp/osid-protocol-host-target npm run check:osid`, all 9 gates passed. Offline registry metadata was restored from preserved cache to private temporary storage; no dependency versions or Rust source changed. Standard networked setup remains documented.
