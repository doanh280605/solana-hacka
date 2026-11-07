# osid worker

The Fastify worker runs the product-listing service, wallet sessions, durable execution and private delivery. Historical V1 PNG-to-WebP endpoints remain available for old Holdfast orders. Run **one worker process per storage directory**.

From the repository root, with Node 22 and the root `.env` prepared:

```sh
npm run dev:worker
npm run typecheck --workspace @holdfast/worker
npm test --workspace @holdfast/worker
```

The workspace package keeps its legacy name for root-script compatibility. No additional runtime dependencies were introduced for V2.

## Configuration

Required public chain configuration: `RPC_URL`, `PROGRAM_ID`, `MINT`, `MERCHANT`, `CLUSTER=localnet|devnet`. Six decimals and `5000000` base units mean exactly **5 mock USDC**, never real USDC or mainnet money.

V2 additionally requires `PROVIDER` and `PROVIDER_KEYPAIR_PATH`, pointing to a dedicated Solana signer with disposable fee funds. The key must match `PROVIDER`, differ from the merchant and buyer wallets, and differ from the program's upgrade authority. Startup reads public program-data metadata to reject upgrade-authority key reuse. The worker never loads buyer or deployment-authority keys. Its provider key signs only result-submission transactions built through the shared SDK.

| Variable | Default / behavior |
| --- | --- |
| `AI_MODE` | `live`; only explicit `fixture` selects development fixtures |
| `OPENAI_API_KEY` | Server-side key required for live quotes and generations |
| `OPENAI_TEXT_MODEL` | `gpt-4.1-mini` |
| `OPENAI_IMAGE_MODEL` | `gpt-image-1.5` |
| `AI_TIMEOUT_MS` | `240000`, range 1000–600000; text stage is capped at 120000 |
| `OSID_QUOTE_LIFETIME_SECONDS` | `600`; quote validity begins after AI interpretation |
| `OSID_ORDER_LIFETIME_SECONDS` | `1800`; execution/refund deadline, must exceed quote lifetime |
| `OSID_MAX_QUOTES_PER_HOUR` | `6` per wallet; acknowledged and failed draft attempts count |
| `OSID_MAX_CONCURRENT_GENERATIONS` | `2`; quotation and execution share this bound |
| `OSID_ALLOW_REHEARSAL_STALL` | Only literal `true` enables explicitly labeled stall jobs |
| `SESSION_LIFETIME_SECONDS` | `3600`, range 60–86400 |
| `WORKER_DATA_DIR` | `.local/worker` relative to launch directory |
| `WORKER_HOST`, `WORKER_PORT` | `127.0.0.1`, `8787` |
| `WORKER_PUBLIC_ORIGIN` | `http://localhost:8787`; signed download domain and HTTPS cookie policy |
| `CORS_ORIGINS` | `http://localhost:5173,http://localhost:4173`; exact allowed frontend origins |
| `CHALLENGE_LIFETIME_SECONDS` | `60`, range 5–300 |
| `ORDER_LIFETIME_SECONDS` | `120`; historical V1 PNG service only |

Missing live credentials produce HTTP 503 **before funding**. No fallback silently claims live AI. `GET /api/v2/service` returns only mode, configuration availability and rehearsal enablement so the UI can label fixture operation. Keep secrets in the ignored environment, never in browser variables, logs or source. The configured OpenAI account must already have access and credits; this code does not provision billing or accept terms.

## Service and authentication

The exact schemas and canonical commitment encoding are in [`docs/INTERFACES.md`](../../docs/INTERFACES.md). Routes:

- `POST /api/auth/nonce {wallet}` and `POST /api/auth/verify {wallet,nonce,signature}` implement real Ed25519 wallet sign-in. The base64 signature binds the exact server-issued message: frontend domain, wallet, purpose, URI, cluster, issue/expiry times and nonce. Nonce consumption persists atomically.
- `GET /api/auth/session` returns `{wallet,expiresAt,csrfToken}`. Sessions use random opaque cookies; only token hashes are stored. Cookies are HttpOnly, SameSite=Lax and Secure when the configured worker origin is HTTPS. `POST /api/auth/logout` revokes the session. Signing in with another wallet rotates a presented prior session.
- Credentialed frontend requests require `credentials: include`. Authenticated mutations require the exact trusted `Origin` and `X-Osid-CSRF`. Quote/detail/history/preview/funding-notification access requires the original buyer session. Nonce and verification endpoints have wallet/IP rate bounds and small body limits.
- `POST /api/v2/orders` accepts one multipart `file`, `buyer`, `brief`, and optional `mode=normal|stall`. Inputs are fully decoded single-frame PNG/JPEG/WebP, at most 5 MiB and 4096 pixels per dimension; briefs are 20–2000 characters.
- `GET /api/v2/orders`, `GET /api/v2/orders/:id`, `POST /api/v2/orders/:id/funded`, and `GET /api/v2/orders/:id/preview/:name` provide buyer history, reconciled state and watermarked previews. A supplied transaction signature is only a hint; it never proves funding.
- `POST /api/v2/orders/:id/challenge {buyer}` and `/download {buyer,nonce,signature}` use a **separate**, expiring, single-use download signature. A login signature cannot authorize money or private downloads. Download challenges bind the buyer, order, domain, terms hash and exact result manifest hash. Repeated issuance preserves a pending challenge. Consumption persists before bytes are returned.

There is no worker refund endpoint. `/recover` uses compiled trusted configuration and direct Solana RPC, without this service, sign-in or its cookie. The original buyer still signs every refund transaction. Release and refund also require distinct buyer transaction confirmations; login never spends funds.

## AI execution and artifacts

Live operation calls OpenAI **Responses** with strict JSON schemas to interpret the brief and produce listing copy, and **Image Edits** with the uploaded photograph to make the creative hero edit. `gpt-image-1.5` uses high input fidelity. The prompts preserve product identity and prohibit invented specifications, prices and certifications. Specification facts must be exact substrings of the seller's brief. Copy validation rejects new numeric tokens and detected unsupported price/certification claims; this is a limited guard, not a factual-quality proof. Buyer review remains necessary.

The fixed exports are `hero.webp` at 1600×1600; `social-square.webp` at 1080×1080; `social-portrait.webp` at 1080×1350; and `social-story.webp` at 1080×1920. The creative edit is requested at 1024×1024 and then exported with containment to preserve the whole product. Listing limits are title 80 characters, description 1200, and exactly five nonempty bullets of at most 180 characters each.

Before any chargeable request, the worker persists a stage/attempt ID. It records provider request/response IDs as they arrive. Responses run in background mode with stored IDs, allowing safe GET reconciliation. Only retrievable GET polling has bounded retries; generation POSTs are never blindly repeated. Image Edits do not provide a retrievable response resource here: a crash or timeout with unknown completion enters a failed/reconciliation state and remains refund eligible. An operator must reconcile an uncertain charge externally; the application offers no automatic regenerate endpoint.

Completed copy and edited-image bytes are persisted before advancing. Restart resumes safe complete stages, never re-generates a submitted or paid pack, and independently rechecks finalized chain data. The worker verifies every agreed V2 party, mint, amount, deadline, PDA, input/specification/terms hash and vault field. A complete pack and matching finalized provider submission are both required before preview readiness.

Each downloadable ZIP contains:

```text
hero.webp
social-square.webp
social-portrait.webp
social-story.webp
listing.json
validation.json
manifest.json
```

The canonical manifest hashes the six payload files in `artifacts`, binds the job and terms/input/specification commitments, and excludes its own self-hash. Its separate, path-sorted `previews` array commits all four watermarked preview files with `path`, `sourcePath`, `sha256`, `bytes`, `width`, `height`, and `mimeType`; previews are not included in the ZIP. Preview serving checks those committed bytes and dimensions and rejects mutable cache metadata that differs. Its SHA-256 is the onchain result commitment. The ZIP hash is stored separately. The ZIP writer uses fixed safe filenames, deterministic ZIP32 store records and CRC32; no public paths or original uploads are exposed. The validation report checks actual formats/dimensions, listing fields/limits and completeness. Hashes bind bytes and agreement, **not** aesthetic quality or truth.

Files and metadata use private OS permissions, same-filesystem atomic replacement and `fsync`. Before any preview or download, all committed payload hashes, canonical manifest bytes, review copy/validation, preview files and deterministic bundle bytes are rechecked. Private delivery additionally requires finalized `Released` and the original buyer's valid one-time download signature. Sensitive responses are `Cache-Control: no-store`. Missing or corrupt submitted files fail closed; ordinary storage remains an availability dependency and does not guarantee permanence or cryptographic fair exchange.

## Verification and limits

`npm test --workspace @holdfast/worker` includes the original V1 regression tests plus V2 auth, CSRF, ownership, commitment/vault mismatches, timeout/failure handling, provider request schemas, replay, restart recovery, duplicate-generation prevention, byte integrity, archive CRC compatibility through system `unzip`, and private delivery tests. Chain state and provider HTTP are explicitly mocked in these unit tests. They do **not** establish live AI, actual wallet UI, program execution or Devnet settlement. Root local/Devnet rehearsals and new evidence must establish those gates separately.

Official integration references: [Structured Outputs](https://developers.openai.com/api/docs/guides/structured-outputs), [background Responses](https://developers.openai.com/api/docs/guides/background), [Image Edits](https://developers.openai.com/api/reference/resources/images/methods/edit). This remains a single-process prototype with local durable storage, mock tokens, bounded quotes and no arbitration or performance bonds.
