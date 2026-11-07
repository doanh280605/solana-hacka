# osid execution status

Updated November 7, 2026, 00:27 UTC (November 6 Pacific). Branch `integration/osid-v2`, based on verified Holdfast V1 commit `eca59b5`. **The core goal remains incomplete: real runtime AI verification needs the missing provider credential.** Fixture content does not count as live AI.

## Implemented

- osid landing page, labeled no-wallet sample, signed wallet sessions, integrated listing workspace, buyer review/approval, private ZIP delivery and independent V1/V2 recovery.
- Server-side OpenAI adapter for structured specification interpretation, source-image editing and grounded listing copy. Bounded requests, durable attempts/provider IDs, safe GET reconciliation and no blind chargeable regeneration.
- Fixed pack: 1600×1600 hero; 1080×1080, 1080×1350 and 1080×1920 social exports; title 80 / description 1200 / five bullets 180; validation, canonical manifest and ZIP. All payloads and four review previews are committed.
- Additive V2 escrow with immutable terms/input/specification/result commitments, dedicated provider submission, buyer-only exact-result approval, exact settlement and refunds from both pending states. V1 layouts/instructions remain unchanged.

## Verified

| Gate | Actual result/evidence |
| --- | --- |
| Aggregate | All nine gates pass: 76 worker/client/web unit tests, 10 Rust tests, four TypeScript checks, production Vite build and whitespace checks. [Saved report](../evidence/osid-checks.json). |
| Actual local program | 39 passed: 17 V1, 11 V2, 11 independent cases. [Serialized report](../evidence/osid-program-localnet.json). |
| SBF/IDL | 467120-byte artifact, SHA-256 `b59f0a228e24782e869316201faf17c4e39a7111082065fc42a51d418122e2a0`; checked/generated IDL match; local and Devnet executable bytes independently match. |
| Local HTTP | Fixture quote/fund/submit/approve/private ZIP; committed previews; login/download replay and other-wallet rejection; persisted sessions/output after restart; actual API-stopped refund. [Report](../evidence/osid-rehearsal-localnet-fixture.json). |
| Local browser | Exact token movement, identical verified downloads after restart/reload, desktop/mobile captures and API-stopped refund with zero recovery merchant requests. [Report](../evidence/osid-ui-localnet-fixture.json). |
| Devnet upgrade | Correct genesis, finalized upgrade, full artifact hash, immutable config and V1 terminal compatibility independently verified. [Deployment](../evidence/osid-deployment-devnet.json). |
| Devnet browser | Real V2 funding/provider submission/approval, exact 5,000,000-unit release, manifest-verified 438,609-byte ZIP, identical download after restart/reload. Separate original-buyer timeout refund with API process exited before expiry; connection refused before/at/after; recovery trace empty. [Fixture report](../evidence/osid-ui-devnet-fixture.json). |
| Independent review | Authorization, commitments, exact settlement, recovery, AI attempts, authentication, storage, ZIP/preview integrity, dependency exposure, browser/process handling and Vite private-file boundaries reviewed; material findings resolved. [Report](OSID-REVIEW.md). |
| Managed preview | All four routes passed desktop/mobile Chrome smoke; no page errors or recovery merchant requests. [Report](../evidence/osid-preview.json). |

Devnet Released job: `C1znz7aJWDBhCMfKAYkzfLTPqCgWf4iSgx6tWv6JqQVa`. Refunded job: `4r5egHtAkGXrjfjrDh4VjpgNwWoxPWWh53qbG1DWBhkD`. [Approval receipt](https://explorer.solana.com/tx/PxHM6mSurVdFtX71Uh9Mtpbh3DRtrcVrTZSWQi5DeUntdKxk81xfKcgGjdMTgpXPAebjiw8HVD1bDLPiMtpLdHP?cluster=devnet), [refund receipt](https://explorer.solana.com/tx/26F8zsnmsTqLgjRzR5nPCJnRZz7VmGpTJvYEjDzk1UQLHDG6D69oUjCeMJxaYo3GFKu5WEz6SNxTru3AmaUZkS3s?cluster=devnet). The new result manifest hash is `f36cd09ebf165ed0e67d9c0ee75644635bf0853fce1a8619a0ef22a9b7b5dbad`.

Browser money actions used a disposable injected test wallet; **an actual Phantom extension was not verified**. Provider unit HTTP is mocked; application rehearsals explicitly use fixture generation. The [108-second Devnet walkthrough](../evidence/osid-demo-devnet-fixture.webm) is a silent captioned screenshot presentation of verified captures, with [source hashes/captions](../evidence/osid-demo-devnet-fixture.json). Raw browser videos and desktop/mobile PNGs are retained. Nothing was published.

## Working preview

- Landing: http://localhost:5173/
- Labeled sample: http://localhost:5173/demo
- Workspace: http://localhost:5173/app
- Independent recovery: http://localhost:5173/recover
- Worker health: http://localhost:8787/health

Current preview is **fixture AI on Devnet**. Web PID 63428; worker PID 63373. Exact entries/logs are in ignored `.local/osid-preview.json`; logs are `.local/osid-preview-web.log` and `.local/osid-preview-worker.log`. Stop only these verified processes with `npx tsx scripts/preview.ts stop`. Restart with `npx tsx scripts/preview.ts start --fixture`. Do not run Vite canary tests or modify app environment/configuration during a browser transaction rehearsal: they can restart another development server.

## Remaining gate and limits

The actual live Devnet attempt authenticated but returned HTTP503 before quote/funding because `OPENAI_API_KEY` is absent. [Blocked report](../evidence/osid-rehearsal-devnet-blocked.json). The user was asked once to configure an existing key in ignored `.env`; no paid terms, plan or billing commitment was created. After configuring it, stop the fixture preview, run `npx tsx scripts/osid-rehearse.ts devnet`, verify the actual AI pack and receipts, then start `npx tsx scripts/preview.ts start` for live mode. Never silently fall back to fixtures.

Run one worker per storage directory. Files depend on available storage/backups. The program remains upgradeable and unaudited; mock tokens have no monetary value; rent and accidental surplus remain locked. Hashes bind agreement and bytes, not subjective quality, truth, permanence or cryptographic fair exchange. Refunds need an original-buyer transaction. Performance bonds, arbitration and marketplaces are deferred. Remaining transitive dependency advisories and their assessed paths are recorded in the independent review; the tree is not claimed vulnerability-free.

Implementation commit `19bc4848bb389e41448d7c01b2ff2d217f269093` was pushed normally; the same feature branch carries final hardening/evidence/handoff. Use `git rev-parse HEAD` and `git ls-remote origin refs/heads/integration/osid-v2` to compare its current revision. The default branch was not merged or force-pushed.

Historical V1 evidence and its 64-test audit are preserved in [V1 status](HOLDFAST-V1-STATUS.md), [V1 review](HOLDFAST-V1-REVIEW.md), [V1 audit](HOLDFAST-V1-COMPLETION-AUDIT.md) and files without the osid prefix. They do not demonstrate V2 or live AI. [V1 binary preservation](../evidence/osid-baseline-preservation.json).

Official MLH schedule checked November 6: initial submission November 8 at 07:00 Pacific; final at 08:45 Pacific. [Official schedule](https://events.mlh.com/events/15200-solana-hackathon). No entry was submitted.
