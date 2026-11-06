# Holdfast browser client

From the repository root, run `npm install`, configure the public `VITE_*` values in `apps/web/.env.local` from `.env.example`, then run `npm run dev:web`. The worker defaults to `http://localhost:8787`.

Use a Phantom-compatible injected Solana wallet funded with the configured mock USDC and test SOL. The checkout signs real transactions; download ownership uses a wallet message signature. No wallet keys belong in Vite configuration.

The checkout and compiled recovery settings must match exactly. Rebuild after changing the RPC, program, mint, merchant or cluster. Run `npm run build` to produce `dist/`; static hosting must serve `index.html` for `/recover` as well as `/`.

`/recover?job=<job-address>` reads only Solana RPC. It does not load configuration, job metadata or refund instructions from the merchant API. Keep the static web server available while stopping the worker to demonstrate offline recovery. The connected wallet must be the recorded buyer; the refund button waits for the onchain deadline.

Local saved purchases plus the merchant's durable order list restore checkout state after reconnect. A released purchase can obtain a new signed download challenge while merchant storage is available. The private original is never exposed as a public file link.

`npm run typecheck --workspace @holdfast/web` checks browser source. `npx tsx scripts/ui-rehearse.ts localnet --smoke` checks desktop/mobile rendering without funding. The full `npx tsx scripts/ui-rehearse.ts localnet` tests real browser release, download/reload, and independent refund after terminating its owned worker. It uses a disposable wallet injected exclusively by the Node harness; it does not verify the Phantom extension. See the root README for chain deployment and rehearsal prerequisites.
