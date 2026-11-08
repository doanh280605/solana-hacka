# osid browser client

The frontend provides four routes:

- `/`: the product landing page and synthetic before/after example.
- `/demo`: a clearly labeled fixture walkthrough. No wallet, application AI requests, live balances or transactions.
- `/app`: authenticated product-listing workspace, versioned quote, escrow funding, private previews, buyer approval and signed ZIP delivery.
- `/recover?job=<address>`: independent V1/V2 refund client. No merchant API or authentication requests.

From the repository root, install dependencies with `npm install`, copy `apps/web/.env.example` to `apps/web/.env.local`, and set the public configuration to match the worker. `VITE_PROVIDER` is the dedicated provider signer's **public address**. No private keys or AI provider credentials belong in Vite variables. Then run `npm run dev:web` and open `http://localhost:5173`.

The workspace compares the worker's program, mint, merchant, provider, RPC and cluster with the compiled recovery settings before funding. Rebuild whenever these settings change. Use the same hostname for the browser and worker (`localhost` for both) so local session cookies work. The worker must allow that exact frontend origin with credentials.

Use a Phantom-compatible injected Solana wallet with test SOL and the configured six-decimal mock USDC. Connecting is separate from authenticating: **Sign in with wallet** signs a server nonce bound to this domain, wallet, purpose and expiration. Funding, approving and refunding each require a separate transaction confirmation. Downloads require a separate one-time ownership signature. Changing wallets clears the local session and logs out the previous server session.

The app accepts PNG, JPEG and WebP up to 5 MiB and 4096 × 4096. Write a 20–2000-character factual brief. The standard quote is valid for 10 minutes; the fixed execution/refund deadline is 30 minutes after quote creation. The exact deadlines are displayed before funding. Deliverables are one 1600 × 1600 WebP hero; three 1080-wide WebP social exports (1080, 1350 and 1920 high); title ≤80 characters; description ≤1200; exactly five bullets ≤180 characters each; validation.json; and manifest.json in a private ZIP.

The browser recomputes the specification and terms commitments before funding, checks recorded V2 fields against Solana, and verifies the canonical manifest/result binding before showing the pack for approval. The committed manifest also names all four private previews and their source artifacts. Each preview is fetched with the session, checked against its committed SHA-256, byte size, MIME type and WebP dimensions, then decoded and checked again before any object URL is created or approval is enabled. Displayed listing/validation JSON and the downloaded ZIP payloads are also checked against the committed manifest. Deterministic validation does not prove aesthetic quality or factual correctness. Review all images and product claims. A refund is buyer initiated; it does not happen automatically.

`GET /api/v2/service` makes fixture mode and unconfigured live AI visible before quoting. Recovery rehearsal controls appear only when the backend explicitly enables them. Fixture packs never count as live AI evidence.

Local browser storage keeps only public purchase/recovery metadata. It also recognizes the historical `holdfast.orders.v1` key so old deposits remain accessible. Private images are fetched with credentials, no-store, and displayed through short-lived object URLs. Briefs, listing copy and session credentials are not persisted in localStorage.

To demonstrate API-offline recovery, keep Vite and Solana RPC running and stop only the verified worker process. Open the saved `/recover?job=...` link, connect the original buyer, wait until the finalized chain clock reaches the deadline, then confirm the refund. This route supports both Funded and Submitted V2 states and historical Funded V1 jobs.

Run `npm run typecheck --workspace @holdfast/web`, `npm run build --workspace @holdfast/web` and `node --import tsx --test apps/web/test/previews.test.ts`. The preview regressions use actual worker-produced WebP bytes and reject changed bytes, dimensions, content type, source bindings, incomplete commitments and animated/invalid containers. Serve `dist/` with an SPA fallback for all four routes. Root verification scripts document the actual injected test-wallet harness; using that harness does not verify the Phantom extension.

`public/sample-before.webp` and `public/sample-after.webp` were made with the assistant's built-in image tool solely as sample artwork. Provenance and prompts are in `public/SAMPLE-ASSETS.md`. They are not proof of application runtime AI. Historical scripts/screenshots remain V1 evidence and must not be presented as osid V2 verification.

The dev server has an explicit file boundary: only `apps/web`, `packages/chain` and root `node_modules` are allowed. Runtime data, key directories, tool caches, target builds, environment files, credentials and certificate/key formats are denied. A pre-serving realpath check also protects public-file aliases and symlinks, because Vite's native fs deny list does not apply to public assets. Keep private files outside `public` regardless. See the [official Vite file-serving documentation](https://vite.dev/config/server-options.html#server-fs-allow).

Run `node --import tsx --test apps/web/test/dev-server-security.test.ts` for the live HTTP regression. It starts and stops its own isolated native Vite process, creates only harmless random canaries, proves direct/raw/normalized traversal and public aliases cannot return them, checks browser source/SDK/dependency/sample imports, and removes its own canaries. It requires permission to bind a local test port.
