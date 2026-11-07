# osid demo script

“Approve the work. Then release the payment.” osid helps small sellers turn a product photo and factual brief into a listing pack while retaining control of payment.

## Two-minute walkthrough

| Time | Say | Show |
| --- | --- | --- |
| 0:00–0:12 | “osid, built for the Solana Hackathon. One photo becomes a listing pack. The buyer reviews the work before releasing payment.” | Landing page and before/after. Label sample artwork as synthetic and prerecorded. |
| 0:12–0:28 | “This demo has no wallet or live transaction. The workspace is the real service.” | `/demo` fixture label, brief, agreed image sizes and copy limits, validation and sample receipt. Switch to `/app`. |
| 0:28–0:45 | “I sign in with my wallet, upload a photo and supply the product facts. AI interprets a versioned specification before I deposit anything.” | Separate sign-in signature; upload; quote, exact deliverables, 5 mock USDC, quote validity and refund time. |
| 0:45–1:05 | “Funding requires its own wallet transaction. The provider edits the source image and generates grounded listing copy. The result is saved before its commitment is submitted.” | Funding receipt, generated pack, all four verified previews, copy and deterministic validation. Identify fixture mode if that is the recorded run. |
| 1:05–1:22 | “The checks verify dimensions, fields and bytes. I still review identity, aesthetics and claims. My separate approval releases exactly five tokens to the recorded merchant.” | Review checkbox, approval transaction, Released receipt, separate signed download and manifest-verified ZIP. |
| 1:22–1:48 | “For this separate stalled job I stop the API. At the deadline, recovery talks directly to Solana. Only the original buyer can sign the refund.” | Saved recovery link, owned API process exit/connection refused, `/recover`, zero merchant network requests, refund confirmation. |
| 1:48–2:00 | “Solana enforces consent, commitments, amount and timeout. Hashes do not prove AI quality. Storage availability still matters.” | New V2 Released/Refunded states and transaction links. |

## Recording rules

Use only evidence whose configuration and AI mode match the narration. A fixture run demonstrates real escrow and delivery plumbing, not live runtime AI. The assistant-generated sample photographs are independent sample assets, not proof of the worker calling an AI provider. Historical Holdfast V1 recordings remain in [HOLDFAST-V1-DEMO.md](HOLDFAST-V1-DEMO.md); never relabel them as osid V2.

Browser verification uses a disposable injected test-wallet harness. It does not establish actual Phantom-extension behavior. Login, funding, approval, download authorization and refunds are separate signatures. Mock USDC has no monetary value; SOL fees are separate. Refunds require a buyer transaction and do not happen automatically.

Run `npx tsx scripts/osid-ui-rehearse.ts devnet --fixture` for an explicitly labeled fixture recording, or omit `--fixture` only when live AI is configured. The harness saves raw workspace/recovery videos and desktop/mobile screenshots under `evidence/osid-ui-*` and `evidence/screenshots/osid-ui-*`. Review the saved PNGs and evidence JSON before editing a demo artifact. Avoid exposing cookies, private inputs, environment values or keys.

Current verification and remaining gates are in [STATUS.md](STATUS.md). This file is a narration guide, not a claim that an unrecorded live flow passed. Public video publication and hackathon submission remain participant actions.
