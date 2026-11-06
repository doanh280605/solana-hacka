# Holdfast — draft submission

## Event and deadlines

Verified November 6, 2026 against the [MLH event schedule](https://events.mlh.com/events/15200-solana-hackathon): hacking starts November 6 at 9:00 a.m. Pacific; initial submission November 8 at 7:00 a.m. Pacific; final submission November 8 at 8:45 a.m. Pacific. The [MLH Challenges portal](https://www.mlh.com/events/solana-hackathon) currently reports submissions open and a closing timestamp of November 8 at 18:00 UTC (10 a.m. Pacific), which conflicts with the schedule. Evidence: `evidence/event-portal.json`. Keep the earlier 7:00/8:45 deadlines until organizers clarify. The public portal identifies `/events/solana-hackathon/submissions/new`; the logged-in submission form is unverified. Target a recorded demo and saved draft Saturday, November 7, by 8 p.m. Pacific.

Track: DeFi, for refundable stablecoin payments. Best Beginner is conditional: the event describes teams with more than half first-time hackers; ask organizers whether first-time Solana builders qualify when they have prior hackathon experience. Do not assert eligibility before confirmation.

## Submission copy

**Name:** Holdfast

**Source:** [github.com/doanh280605/solana-hacka](https://github.com/doanh280605/solana-hacka), public repository; default branch `main`.

**Tagline:** Pay for digital work with a way to get your money back.

**Problem:** A small automated merchant can charge a buyer and then fail to deliver. A refund promise is weak when the merchant's server is offline.

**What it does:** A buyer uploads a PNG and deposits five mock USDC into a Solana program vault. The worker verifies finalized funding, converts the file, and saves the original before showing a watermarked preview. Only the buyer can approve payment to the recorded merchant before expiry. If the job stalls or approval never happens, the buyer can recover the deposit at the chain deadline using a separate recovery page, even with the merchant API stopped.

**Why Solana:** The vault, buyer consent, recipient, integer token amount, deadline and permanent terminal state are enforced together on chain. The recovery client reads the program directly and sends a buyer-signed refund without asking the merchant for permission. The UI shows buyer, merchant and vault balances and links real transactions.

**Implementation:** Rust/Anchor program, legacy SPL Token mock stablecoin, TypeScript client, React/Vite checkout and recovery page, Node/Fastify worker, sharp PNG-to-WebP conversion, durable local storage, and expiring single-use Ed25519 download challenges.

**Trust and limitations:** The program secures payment rules; conversion and delivery still depend on the merchant and durable storage. The demo token has a disposable mint authority and no monetary value. The deployed program remains upgradeable by the disposable deployment wallet. This is a hackathon prototype, not an audited production payment system. Job/vault rent is retained to preserve replay protection; accidental extra vault tokens remain locked. Use one worker process per storage directory.

**Evidence:** [Deployed program](https://explorer.solana.com/address/7cW6fScgHCAWBo9YDQEhuS6brFjssJSmomRN11Xa9iKY?cluster=devnet), [browser payment release](https://explorer.solana.com/tx/2KoexF5XBk6g66r1rHvSTh9XW71hTycDB5ngYGiwPh4FwaBvpZch5XkHhWbgzpPLQgq8kgJPxWT5en3mDHcBUMoJ?cluster=devnet), [browser API-offline refund](https://explorer.solana.com/tx/Yf3vqNYDdueKTapA9T8TPSANAWJxmSuydXsEPNJKDh3MVaz1h9NdmSnPMWdzLvWt86Kx9a7NWxh3pTrnXhTg9Ah?cluster=devnet). All three Devnet rehearsals pass, including real PNG conversion, persisted original, signed private download, restart/reload recovery and exact five-token settlement. [Full status and balance evidence](STATUS.md). The browser uses an injected disposable test wallet; the Phantom extension was not manually verified.

**Learning / challenges:** Learned PDA-controlled SPL token custody, atomic settlement, finalized chain reconciliation, independent expiry recovery, and signed digital delivery. The build required aligning the Anchor compiler, SBF toolchain, generated IDL and TypeScript ABI. Edit this paragraph with the participant's own learning experience before submission.

**AI disclosure:** OpenAI Codex coordinated the build, delegated program/worker/frontend work, generated and reviewed code, ran verification, and drafted documentation. The frontend-design skill supplied UI guidance. Participant must review this description and add any other AI tools actually used. No AI service is part of the PNG conversion product.

## Participant actions before submission

The [MLH standard rules](https://github.com/MLH/mlh-policies/blob/main/standard-hackathon-rules.md) allow AI assistance with disclosure. Their digital-event section requests a public demo video no longer than two minutes, beginning with the hackathon name; code and video must remain public for prize eligibility. Event-specific organizer instructions take precedence.

1. Confirm registration and team details in your MLH account; inspect the actual logged-in submission fields.
2. Review the verified Devnet links above, the short demo script, and the [113.92-second captioned Devnet recording](../evidence/demo-devnet-draft.mp4). The recording is silent and discloses its injected wallet and accelerated checkout.
3. Review/edit the final <=2 minute demo. The prepared recording already opens with the hackathon name; add personal narration if desired. Keep its Devnet, mock-token and test-wallet disclosures.
4. Source publication is done: the user authorized the push to the public repository linked above. Publish the final video through the participant's account. Final MLH submission remains the participant's action.
5. Submit initial entry by Sunday 7:00 a.m. Pacific and final updates by 8:45 a.m.; verify the portal marks the entry submitted.
6. Confirm Best Beginner eligibility with organizers if entering that track.
