# osid V2 independent review

Review date: 2026-11-06. Reviewer is separate from the frontend, service and protocol implementation owners. This is a focused adversarial review, not an external audit. Historical V1 evidence is not V2 verification.

## Findings and disposition

1. **High: displayed listing and validation were not bound to the approved manifest. Resolved.** The original `assertResult` checked the manifest's onchain hash but accepted changed `order.listing` and `order.validation` fields. An altered API response could therefore display different review content under the same result commitment. The frontend now checks the canonical UTF-8 length and SHA-256 of both displayed objects against their exact manifest entries. The independent regression changes each displayed object while retaining the submitted manifest; both are rejected.
2. **Medium: the browser accepted any response with a ZIP magic header. Resolved.** Server-side delivery already verified the durable pack, but the browser did not independently bind downloaded bytes. The new browser verifier checks the complete bounded ZIP32 store format, entry counts/names, CRCs, directory offsets, canonical manifest and all six payload hashes before offering a download. Independent tests use the worker's actual ZIP producer and reject a valid-CRC substituted payload, hidden file, trailing bytes and altered directory offset.
3. **High: inherited native image-decoder advisories required remediation. Resolved dependency exposure.** `sharp@0.34.4` decoded metadata before the format allowlist rejected unsupported uploads. Consequently that allowlist alone did not prevent vulnerable GIF/TIFF/VIPS/SVG parsers from seeing hostile input. The integration lead pinned and installed `sharp@0.35.5`, covering the audited advisories. See the [libvips advisory](https://github.com/lovell/sharp/security/advisories/GHSA-f88m-g3jw-g9cj) and [librsvg advisory](https://github.com/lovell/sharp/security/advisories/GHSA-wq5f-xc86-pv6w). No exploit payload was executed.
4. **High functional reliability: a funded job waiting for AI capacity was dropped. Resolved.** `schedule()` returned when the configured generation limit was occupied and removed the waiting job from its task map. Capacity becoming available did not reschedule it. An acknowledged order could remain processing indefinitely if its buyer closed the tab. The independent reproduction initially failed with the second job still Funded after the first completed. The service now reserves FIFO capacity before acquiring the order lock, retains queued task promises and hands capacity over after either a generation or a prequote request completes. Both independent no-polling regressions pass. Shutdown leaves unstarted work durable for restart. Buyer refund safety was preserved throughout.
5. **Medium: image review derivatives were outside the frozen manifest. Resolved.** Originals and copy were already frozen correctly, but preview hashes lived only in mutable order metadata. The independent test originally replaced a preview with a valid same-size red WebP and updated its mutable hash/size; the original submitted result hash remained unchanged, yet the endpoint served the replacement. The result manifest now freezes a separate four-preview array with hashes, sizes, dimensions, MIME types and source paths. The worker verifies that array and preview bytes; the browser verifies committed bytes and container/decoded dimensions before displaying them or enabling approval. The worker substitution regression now rejects the change, and browser regressions reject pixel substitution, dimension lies, swapped source roles and animated containers. This freezes the image review set without claiming that hashes prove aesthetic quality or semantic equivalence between previews and originals.
6. **Medium functional reliability: managed preview did not detect IPv6 localhost listeners. Resolved.** The old `portUnused()` probed only 127.0.0.1 while managed Vite binds localhost, and an isolated temporary ::1 listener was missed. The helper now probes both loopback families, rejects occupied ports and skips only unavailable IPv6 support. Independent reruns confirmed rejection for both occupied families and acceptance after each listener closed. Managed launch checks owned child exit/error/liveness before and after HTTP health, and stop distinguishes process-inspection failure from an already-exited PID. Existing project processes were not stopped during the reproduction or regression.
7. **Medium functional integration: credentialed workspace configuration fetch was blocked by CORS. Resolved.** The integration lead's actual browser run found that the shared client requests `/api/config` with credentials while that route omitted `Access-Control-Allow-Credentials`. Funding remained disabled, so the failed run moved no tokens. The worker now supplies credentialed CORS for this exact public-config route only when Origin exactly matches the configured allowlist. Independent tests include query parameters, a valid session cookie, wrong ports/schemes, `null` origin and a hostname lookalike; only the exact trusted origin receives credentialed CORS headers. Existing mutation Origin/CSRF and buyer ownership checks remain in place.
8. **Verification harness: refund button's exact name omitted decimal formatting. Resolved.** The browser script searched for `Refund 5 mock USDC`; the actual recovery component renders `Refund 5.00 mock USDC` using `formatTokens`. An independent direct formatter invocation confirmed the latter. The corrected locator completed the full browser refund while the API was stopped. Program eligibility and the recorded payment amount were unaffected. The runner also observes pending download rejections and performs each cleanup action independently, so artifact-save failures do not skip owned-process shutdown.
9. **High development-server exposure: Vite's default workspace boundary included private runtime files. Resolved.** The frontend owner reproduced a harmless private canary being served before the fix. The development configuration now allows only web sources, the chain package and dependencies, retains Vite's default deny patterns, adds private runtime/key patterns, and checks real paths before static serving, including public symlink aliases. The independent reviewer ran the actual isolated CLI regression successfully and separately probed 19 encoded-path, query, case and public-alias variants. None returned the harmless marker. Some malformed encoded paths return the SPA page rather than an error; they did not return private bytes. These checks created and removed only harmless canaries; actual keys, environment values and private inputs were never read.

## Reviewed invariants

- V2 uses a separate account discriminator and `job_v2` PDA seed. V1 account fields, state discriminants and instructions remain separate. The client rejects incorrect account owner, size, schema, PDA and terms commitment.
- Funding binds exact recorded parties, mint, integer amount, quote validity, execution deadline and input/specification commitments. Provider submission is signer checked, nonzero, before expiry and immutable. Buyer approval requires Submitted plus the exact result hash and is strictly before expiry. Both pending states permit the original buyer's refund at equality/later. Token transfers use the recorded amount and canonical recorded destination; surplus remains in the retained vault.
- Sessions require a server-issued, domain/purpose/wallet/time-bound signed nonce. Nonce consumption, token hashes and session expiration persist. Authenticated mutations verify Origin and CSRF; another wallet cannot access order details/previews. Login never authorizes token actions. Download signatures use a separate persisted single-use challenge and require finalized Released.
- AI attempts persist before chargeable POSTs. Retrievable Responses IDs resume with GET. Unknown image completion is blocked instead of regenerated. Complete stages reuse durable bytes. Artifacts and bundle are fsync-persisted before submission; readiness requires matching finalized submission and intact durable output. Missing output fails closed.
- Private artifacts have fixed filenames under validated random job IDs; no static original/input route exists. Sensitive responses are no-store. Recovery mounts no application-authentication hook or merchant API request and reads trusted compiled configuration/direct RPC.

## Checks actually run by the independent reviewer

| Command | Result |
| --- | --- |
| `node --import tsx --test packages/chain/test/osid-review.test.ts` | 4 passed, 0 failed |
| `node --import tsx --test apps/worker/test/*.test.ts` | 36 passed, 0 failed |
| `node --import tsx --test apps/worker/test/osid-review.test.ts packages/chain/test/osid-review.test.ts` | After fixes: 6 passed, 0 failed |
| `node_modules/.bin/tsc --noEmit -p packages/chain/tsconfig.json` | Passed, exit 0 |
| Three worker review tests after adding preview substitution reproduction | 2 passed, preview substitution failed as expected before fix |
| Latest combined independent worker/client review tests after preview fixes | 8 passed, 0 failed; chain typecheck also passed |
| Read-only finalized local RPC/build/receipt inspection, 2026-11-06 23:27 UTC | Passed; details below |
| Isolated IPv6 loopback listener versus `portUnused()` | Reproduced missed occupied port; listener then closed |
| After fix: isolated IPv4 and IPv6 occupied/released ports | Both occupied cases rejected; both released cases accepted |
| Auth tests plus latest independent worker/client review tests after CORS fix | 13 passed, 0 failed |
| Root and worker TypeScript checks after CORS/script changes | Passed, exit 0 |
| Independent worker/client review tests plus V2 service tests after UTF-8 limit fix | 20 passed, 0 failed |
| Read-only finalized browser receipts and actual repeated downloads, 23:50 UTC | Passed; full local browser evidence below |
| Read-only finalized Devnet upgrade, full artifact and historical V1 jobs, 2026-11-07 00:15 UTC | Passed; details below |
| `node --import tsx --test apps/web/test/dev-server-security.test.ts` | 1 passed, 0 failed; isolated CLI process exited cleanly |
| Additional independent live HTTP canary probes | 19 variants; no private marker bytes returned |

The independent tests also reject changed accepted specifications/providers, a different submitted result and a duplicated manifest path. Both capacity-starvation reproductions and the preview substitution reproduction failed before their fixes and pass afterward. Worker tests mock chain state and provider HTTP. They establish regression behavior, not live AI or chain execution. Earlier attempts stalled while iCloud had evicted source/dependency bytes; only the completed runs above count. The 36-test worker run preceded the additional independent queue/preview tests; final broad regression remains the integration lead's gate.

Actual local-program tests, Devnet transactions, desktop/mobile browser evidence and API-stopped recovery are serialized by the integration lead. This reviewer has performed only read-only chain inspection, not stateful program suites. Live AI verification remains dependent on a configured provider credential. Neither mocked HTTP nor fixture AI satisfies that gate.

The first mobile full-page smoke PNG had a Chrome capture tiling artifact after a viewport resize. The current browser runner waits for fonts, image decoding and two repaints. The independent reviewer visually inspected the fresh `osid-ui-localnet-fixture-landing-mobile.png`: the full hero, sample product, deliverables, process, limitations and footer render once, with readable layout. The later desktop/mobile review and completed-refund PNGs were also inspected; their images, explicit approval/refund wording, validation, exact receipts and mobile layout are readable without tiling or horizontal overflow.

## Independent inspection of actual local chain evidence

At 2026-11-06 23:27 UTC, finalized localhost RPC reported genesis `9Gf7whJU7e2ri5aQBWz3Ph4JmHTuWz7vd4emCmKbHGUq`. The executable is owned by the upgradeable loader. Its ProgramData bytes exactly match the compiled artifact SHA-256 `b59f0a228e24782e869316201faf17c4e39a7111082065fc42a51d418122e2a0`; source provenance and checked/generated IDL bytes also match. This inspection covered the first completed HTTP fixture rehearsal, before the committed-preview addition. Fresh current-manifest HTTP/browser evidence is a separate integration gate.

The SDK independently decoded `QzP9F6KLKFP4Y9FRMNA2eYADQqwLWZDF8HLJYTpKo25` as Released V2 and `Du7uBqHrwuvpMcH4zbkg1J5bg1TD4Ps1KuwFo7bN2Sde` as Refunded V2. Both records exactly match recorded evidence, both terms hashes recompute, and the release manifest hash equals the onchain result. All four independently fetched finalized receipts exist with null transaction errors:

| Action | Signer | Token changes |
| --- | --- | --- |
| Fund | Original buyer | Buyer -5,000,000; vault +5,000,000; merchant unchanged |
| Submit | Dedicated provider | No token movement |
| Approve | Original buyer | Merchant +5,000,000; vault -5,000,000 |
| Refund | Original buyer | Buyer +5,000,000; vault -5,000,000 |

Refund transaction block time 1794007543 is after the recorded deadline 1794007528. The saved rehearsal separately records worker exit and ECONNREFUSED before/at/after recovery. This reviewer inspected those records afterward; the integration lead performed the API-stopped operation. The local program TAPs record 17 V1, 11 V2 and 11 legacy independent-review passes. This is actual local SBF execution and fixture application execution, not Devnet or live AI evidence.

At 2026-11-06 23:42 UTC, a second independent read-only check covered the current committed-preview manifest in `evidence/osid-rehearsal-localnet-fixture.json`: Released job `GGWgak5F5D591jJagxfSD7kFdKV5pNKyB97VRpy17cNP`, Refunded job `4oaF96Bemmt8UcenY9QGhDcVExdoEc2NtUb7nf46UZgy`, result hash `3491ebe52ec539270b4106aad83870e22fb14a4392e8cfcbff114a1ba4226d37`. All four durable preview files passed the browser hash/container-dimension verifier against the onchain manifest. The actual 438,609-byte downloaded ZIP passed the complete browser bundle verifier. AI mode is explicitly fixture.

## Completed local browser evidence

`evidence/osid-ui-localnet-fixture.json`, run `20261106234558108-6df40e`, passed with four buyer-signed transactions, zero browser errors, and zero merchant requests from the independent recovery page. The worker's recorded exit and ECONNREFUSED precede refund eligibility and remain recorded after settlement. Wallet testing used the disposable injected harness; an actual Phantom extension was not verified.

At 23:50 UTC, the independent reviewer fetched all four finalized buyer receipts and the provider submission receipt from local RPC. Decoded actions are FundV2, ApproveV2, FundV2, RefundV2 and SubmitV2. Buyer actions have the original buyer as signer; submission has the dedicated provider as signer. Exact token changes are ±5,000,000 units in the corresponding buyer/vault/merchant accounts; provider submission moves no tokens. Refund block time is at or after the recorded deadline. Released job `BR5yAMVqwWajB4FgUA8LjGuK6TLhSq5szRRzgdmzQLub` and Refunded job `uVosCtCdTP7rh3XXiKXz4dkp5NzSmcumgCAc2ucy7Ue` recompute their terms commitments. The result manifest hash is `03d4bc51a66eaa385d93b6ca8aa7bdd6a8ad7a26f03c2b0d47941bd283f03178`.

Both actual browser-downloaded 438,609-byte ZIP files, before and after worker restart/page reload, are byte-identical and independently pass the browser bundle verifier. Desktop/mobile review and refund screenshots match the recorded lifecycle. This establishes the local browser and API-independent recovery gates using fixture AI; live application AI and Devnet evidence remain separate.

The small UTF-8 upload fix raises the multipart byte bound to 8,000 while keeping the 20–2,000 JavaScript-character validation before AI. Its regression accepts a 2,000-character/6,000-byte brief, rejects character 2,001, and confirms no second provider interpretation. Independent V2 service/review tests pass after this change.

## Independent Devnet deployment and V1 compatibility checks

At 2026-11-07 00:15 UTC, the independent reviewer queried finalized public Devnet RPC. Genesis is `EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG`. The [upgrade receipt](https://explorer.solana.com/tx/2YUXt9tu8YPDTtpXqPpKY1TxyK6P8zW6PvD6MEHVgUaN9ztPemeE7wgvGmK5wDYx5rYfU4ZoobVEjmctbrpdTrM?cluster=devnet) has no transaction error, slot 519474072, and the parsed upgrade references the recorded program, ProgramData account `Fd9Z2DRAYTSpydwnM4BPHm6NkWR7axLEDQS4paC9xBf7`, and persistent upload buffer `8ELrKyQw5HiCjmtL7yNjcYfPtrH2wnPtjfx3E13Pdjg8`. The recorded upgrade authority signed. The executable is owned by the upgradeable loader; ProgramData's deployment slot equals the receipt slot. All 467,120 artifact bytes match SHA-256 `b59f0a228e24782e869316201faf17c4e39a7111082065fc42a51d418122e2a0`, and unused allocation bytes are zero.

After the upgrade, the current SDK independently decoded historical V1 jobs from `evidence/verify-devnet.json`: `BXVAGomEzy69LsyjLE7xL2BEqN8NFJcFuKFXBGBEWs9Z` remains Released, and `nVNcbihHTqLLafw8Jq877fcc4gQXahZevQt5ZrLyjkT` remains Refunded. Both decode as version 1, original buyer `5pRqFSXF2rCMYrKfkzJfp5h5KZYfJbS7tWnDGWY74fAc`, amount 5,000,000, the preserved mock mint and merchant. This verifies decoder compatibility with retained historical terminal records; it does not relabel V1 transactions as V2 proof.

The saved live attempt `evidence/osid-rehearsal-devnet-blocked.json` failed safely at the authenticated prequote stage with HTTP 503 because the provider key is absent. It contains no funding transaction or accepted quote. Live AI execution remains unverified and blocks core completion.

## Completed Devnet browser evidence

`evidence/osid-ui-devnet-fixture.json`, run `20261107001838352-256543`, completed successfully at 2026-11-07 00:25 UTC. It records fixture AI, the disposable injected wallet harness, zero browser errors, zero recovery merchant requests and four buyer-signed transactions. No actual Phantom extension or live AI was verified.

The independent reviewer queried finalized public RPC at 00:24 and 00:25 UTC and checked all five lifecycle receipts, recorded signers and exact token movements:

| Action | Confirmed signer | Buyer / merchant / vault changes |
| --- | --- | --- |
| Release-job FundV2 | Original buyer | -5,000,000 / 0 / +5,000,000 |
| SubmitV2 | Dedicated provider | 0 / 0 / 0 |
| ApproveV2 | Original buyer | 0 / +5,000,000 / -5,000,000 |
| Refund-job FundV2 | Original buyer | -5,000,000 / 0 / +5,000,000 |
| RefundV2 | Original buyer | +5,000,000 / 0 / -5,000,000 |

All five transaction errors are null. Released V2 job `C1znz7aJWDBhCMfKAYkzfLTPqCgWf4iSgx6tWv6JqQVa` recomputes the agreed terms and manifest hash `f36cd09ebf165ed0e67d9c0ee75644635bf0853fce1a8619a0ef22a9b7b5dbad`. The exact result hash is encoded in its buyer approval. Both actual 438,609-byte browser downloads, before and after worker restart/reload, are byte-identical with SHA-256 `4b0ec383c81f51f0c3c85f872cd003b47e3362c9054a375db618bee7ebb4a3d4`. They pass the complete browser ZIP/manifest/payload verifier; displayed copy and validation also pass their committed-byte checks.

Refunded V2 job `4r5egHtAkGXrjfjrDh4VjpgNwWoxPWWh53qbG1DWBhkD` remains a retained terminal record with no submitted result. Its deadline is 1794011081 (00:24:41 UTC). The [finalized refund](https://explorer.solana.com/tx/26F8zsnmsTqLgjRzR5nPCJnRZz7VmGpTJvYEjDzk1UQLHDG6D69oUjCeMJxaYo3GFKu5WEz6SNxTru3AmaUZkS3s?cluster=devnet) has block time 1794011096, after eligibility, and returns exactly the recorded payment to the original buyer's canonical token account.

The saved process evidence records worker PID 59014 exiting successfully at 00:23:55.873 UTC, before the deadline. ECONNREFUSED is recorded at 00:23:56.567, 00:24:48.692 and 00:25:11.643 UTC. The recovery request capture is empty and the merchant request counter is zero. The integration lead performed this API-stopped operation; the reviewer inspected its records and finalized receipts afterward. Independent visual inspection of the Devnet desktop/mobile review and refunded PNGs found readable layouts, explicit fixture labeling and accurate terminal-state/payment wording.

No further production changes were required by the final Devnet review. The missing provider credential and successful live AI lifecycle remain completion blockers; fixture execution does not satisfy them.

## Dependency audit scope

The initial saved npm audit reported 17 affected package entries, including transitive duplicates. The lead installed focused updates: sharp 0.35.5, Vite 7.3.7, Fastify 5.12.8 and bn.js 5.2.5. The subsequent saved `evidence/osid-npm-audit.json` reports 13 entries (5 high, 7 moderate, 1 low); the four updated direct dependencies are absent. Vite's [WebSocket file-read advisory](https://github.com/vitejs/vite/security/advisories/GHSA-p9ff-h696-f583) mattered when exposing its development listener. Fastify's schema and protected custom-not-found exploit preconditions were absent here: request bodies are explicitly validated, no private not-found handler is installed and HTTP/2 is not enabled. Its same-major update also removes avoidable inherited exposure.

The remaining Anchor `toml` dependency parses a local trusted Anchor.toml only. Solana's used jayson browser client parses RPC replies with JSON.parse and generates UUID v4; the advised stream-json filters/Assembler and UUID v3/v5/v6 APIs are not used on this path. `bigint-buffer` remains an inherited advisory without a patched release; the SPL layouts invoke it with fixed 8/16/24/32-byte fields, and this installed runtime reports its pure JavaScript fallback. No safe blanket SDK-major override was recommended. These are scoped reachability observations, not a claim that the dependency tree has no vulnerabilities.

## Remaining boundaries

Buyer review remains necessary for identity, aesthetics and factual correctness. Hashes bind agreement and bytes. Delivery availability depends on merchant storage and its backup policy; paid outputs are never regenerated after loss. Run one worker per storage directory. Mainnet, arbitration, provider bonds and cryptographic fair exchange are outside this prototype.
