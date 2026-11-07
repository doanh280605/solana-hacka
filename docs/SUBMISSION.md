# osid — submission draft

## Product

**Name:** osid

**Tagline:** Approve the work. Then release the payment.

**Source:** [doanh280605/solana-hacka](https://github.com/doanh280605/solana-hacka), implementation branch `integration/osid-v2`. The verified Holdfast V1 baseline remains commit `eca59b5beb295e9d02fe3f57249b62be09b458f1`.

**Problem:** Small sellers need useful product images and listing copy, but paying an automated service before seeing its work leaves them dependent on the service's refund promise.

**What it does:** Upload a product photograph and factual brief. Review an AI-interpreted specification with fixed deliverables, price and deadlines. Deposit five mock USDC into Solana escrow. The service edits the source photograph, creates three social exports and grounded listing copy, validates the pack and saves a private ZIP. The provider submits an immutable manifest commitment. The buyer reviews the work and explicitly approves that exact result to release payment. If the buyer has not approved by the chain deadline, the original wallet can refund directly from Solana, including with the API stopped.

**Deliverables:** One 1600×1600 WebP hero; 1080×1080, 1080×1350 and 1080×1920 social exports; title up to 80 characters, description up to 1200 and five bullets up to 180 each; validation report, canonical manifest and seven-file ZIP. Watermarked review previews are separately bound to the result commitment.

**Why AI:** The running worker has a server-side OpenAI adapter for structured specification interpretation, source-photo editing and listing copy. It treats the seller brief as untrusted data and forbids invented specifications, prices, certifications and unsupported claims. Deterministic resizing derives the social exports from the AI edit. AI output still needs human review. **Live verification is currently pending credentials; fixture tests must not be described as live AI.**

**Why Solana:** Additive V2 accounts enforce the parties, mint, exact integer amount, quote and execution deadlines, input/specification commitments, dedicated provider submission, buyer approval of the frozen result and original-buyer timeout refund. Funded and Submitted both permit refunds at expiry. Retained Released/Refunded records prevent replay. The recovery route uses trusted compiled configuration and direct RPC without application authentication or merchant API access.

**Implementation:** Anchor/Rust escrow, TypeScript client and versioned IDL, React/Vite landing/demo/workspace/recovery, Fastify worker, signed wallet sessions, durable attempts and private artifacts, deterministic validation and ZIP creation, independent single-use download signatures. V1 instructions and account layouts remain compatible. Provider keys stay server-side; buyer and upgrade-authority keys never enter the worker.

**What is distinctive:** A focused seller workflow joins explicit measurable commitments, buyer review, exact settlement and API-independent recovery. This is not a claim to be the first AI payment, escrow or agent marketplace on Solana.

## Evidence and limits

Use [current status](STATUS.md), [completion audit](COMPLETION-AUDIT.md), [independent review](OSID-REVIEW.md) and the new `evidence/osid-*` records for actual results. Files without the osid prefix and the [V1 submission](HOLDFAST-V1-SUBMISSION.md) are historical; they do not establish V2 or live AI. [Demo script](DEMO.md).

Mock USDC has no monetary value. This is an upgradeable, unaudited Devnet prototype. Hashes bind agreement and artifact bytes; they do not prove subjective quality, factual accuracy or cryptographic fair exchange. Files depend on storage availability. There is no arbitration, automatic refund, provider bond, autonomous spending or general marketplace. Run one worker per storage directory. Program/vault rent and accidental surplus remain locked. Phantom-extension behavior is unverified when evidence uses the injected test wallet.

## AI-use disclosure

OpenAI Codex coordinated implementation, used separate frontend/service/protocol agents and an independent review agent, generated and reviewed code, ran tests and drafted documentation. The frontend-design skill informed visual design. The assistant image-generation tool created the clearly labeled synthetic sample candle photographs; those assets are not worker runtime AI evidence. The application's separate OpenAI provider adapter performs specification, image-edit and copy tasks when configured. Fixture mode performs no live AI. The participant should review this disclosure and add any other tools actually used.

## Schedule and participant actions

Official MLH schedule checked November 6, 2026: initial submission Sunday November 8 at 07:00 Pacific; final submission at 08:45 Pacific. [Official schedule](https://events.mlh.com/events/15200-solana-hackathon). Use these earlier times if another portal disagrees. Target the final demo and draft on Saturday evening; deferred bond work must not delay required verification.

Before submitting: configure and verify live AI; confirm the final V2 evidence and branch commit; review a public demo of no more than two minutes with the event name and accurate mode/network/wallet disclosures; supply registration/team details and participant learning notes; confirm track eligibility and organizer-specific requirements. Source push is authorized, but publishing the video, merging to the default branch, deploying production and submitting the entry are outside this implementation authorization. Nothing has been submitted.
