# Shared interfaces — osid

## osid V2 implementation agreement (2026-11-06)

This section defines the new scope; the V1 reference below remains authoritative for historical accounts. Lead owns shared decisions, root configuration/lockfiles, scripts, deployment and evidence. Frontend owns `apps/web`; service owns `apps/worker`; protocol owns `programs/checkout` and `packages/chain`. No agent changes another owner's files, root locks, keys or chain deployments without coordination.

### Chain and commitments

Keep the same program/config/mint and every V1 instruction/account. Add `JobV2`, seeds `job_v2`, buyer, 32-byte job ID; vault seeds stay `vault`, job PDA. State is `Funded -> Submitted -> Released`, or `Funded|Submitted -> Refunded`. Provider alone submits once, before expiry; original buyer alone approves the exact result hash strictly before expiry or refunds at equality/later. Terminal records remain. Preserve canonical ATAs, signer/owner/PDA/mint constraints, integer exact transfers and surplus policy.

`fund_v2(job_id,amount,expires_at,quote_expires_at,input_hash,spec_hash,terms_hash)` accounts follow V1 funding plus a recorded `provider` public key (not signer). Reject zero commitments, invalid time bounds, and a terms hash not equal to the recomputed commitment. `submit_v2(result_hash)` uses provider signer/job and freezes a nonzero result hash. `approve_v2(result_hash)` uses V1 approval accounts and rejects any hash mismatch or pre-submission approval. `refund_v2()` uses V1 refund accounts and accepts both pending states. V2 account additionally records schema version 2, provider, quote expiry, input/spec/terms/result hashes and submission time. V1 bytes/discriminators never change.

Hashes in HTTP/SDK are 64 lowercase hexadecimal characters; onchain `[u8;32]`. Input hash is SHA-256 of uploaded original bytes. Specification and manifest hashes are SHA-256 of UTF-8 canonical JSON: recursively sort object keys by JS code-unit order, retain array order, JSON escaping, no whitespace; only null, booleans, strings and safe integer numbers (no undefined/nonfinite numbers). Strings are exact, without implicit Unicode normalization. Version is part of each object.

Terms hash = SHA-256 of these concatenated bytes: UTF-8 `osid:terms:v2\0`; program public key (32); job PDA (32); job ID (32); buyer (32); merchant (32); provider (32); mint (32); amount u64 LE (8); execution/refund expiry i64 LE (8); quote expiry i64 LE (8); schema version u16 LE (2, value 2); input hash (32); spec hash (32). Rust recomputes this exact encoding. Manifest contains schema version, job ID/address, terms/spec/input hashes and sorted artifact entries with path, media type, size and SHA-256. Never put photos, briefs, copy or credentials onchain. These commitments bind agreement/bytes, not subjective quality or truth.

SDK preserves V1 APIs and exports `deriveJobV2Address`, `buildFundV2Transaction`, `buildSubmitV2Transaction`, `buildApproveV2Transaction`; existing `fetchJob` and `buildRefundTransaction` detect V1/V2. `PublicConfig.provider?:string` supports V1 compatibility but V2 requires it. `Job` retains base fields with optional V2 fields: `version`, `provider`, `inputHash`, `specHash`, `termsHash`, `resultHash`, `quoteExpiresAt`, `submittedAt`; state union adds Submitted. Export `canonicalJson`, async `hashCanonical`, async `computeTermsHash(TermsV2)` and `TermsV2` (`programId,jobAddress,jobId,buyer,merchant,provider,mint,amount,expiresAt,quoteExpiresAt,inputHash,specHash`). V1 fetch may report version 1. Builder argument names are camelCase matching these fields; submit requires `provider,jobAddress,resultHash`; approve requires `buyer,jobAddress,resultHash`.

### Service, specification and artifact contract

Keep historical `/api/orders` functionality readable; new application uses `/api/v2/orders`. V2 requires wallet session for quote creation, order detail/list, previews and funded notification. Recovery uses no session/API. Dedicated `PROVIDER_KEYPAIR_PATH` is mandatory for V2 live execution; reject buyer/deployer key reuse at runtime setup. Provider signs submission only, never buyer money actions.

`GET /api/v2/service` -> public `{aiMode,liveConfigured,rehearsalStallEnabled,service:'product-listing-pack'}` (no keys); this supports honest runtime labels before quote.

`POST /api/auth/nonce {wallet}` -> `{nonce,message,expiresAt}`; signed message binds configured frontend origin/domain, URI, wallet, purpose `Sign in to osid (no payment authorization)`, server-issued nonce, issued/expiration times and chain. `POST /api/auth/verify {wallet,nonce,signature}` (base64 Ed25519 signature) -> `{wallet,expiresAt,csrfToken}` plus HttpOnly SameSite=Lax cookie (Secure on HTTPS). Nonce consumption and session replay state persist. `GET /api/auth/session` -> same session or 401; `POST /api/auth/logout` clears session. Sign-in fallback is real server-verified message signing. Mutating authenticated requests require exact Origin and `X-Osid-CSRF`; fetch uses credentials include. Wallet change clears local session and signs in again. Login never authorizes token actions. Download nonce remains separate.

`POST /api/v2/orders` multipart `{file,buyer,brief,mode=normal|stall}` -> V2 Order. PNG/JPEG/WebP input <=5 MiB, single frame, dimensions <=4096, brief 20..2000 characters. Before quote, AI interprets supplied facts/brief into spec. Quote valid 10 minutes; fixed execution/refund deadline 30 minutes after quote (local isolated rehearsals may explicitly use shorter deadlines). Reject funding once quote expires. AI errors before quote produce no funded obligation. Limit quotes/uploads per wallet and concurrent generations. `mode=stall` is explicitly labeled rehearsal only.

V2 Order extends prior public shape with `version:2,provider,quoteExpiresAt,inputHash,specHash,termsHash,specification,aiMode:'live'|'fixture'`, optional `resultHash,manifest,validation,listing,previews,submissionSignature,attempts`. `specification` has `schemaVersion:2,service:'product-listing-pack',brief,productFacts:string[],imageDirection:string,deliverables:{hero:{width:1600,height:1600,format:'webp'},social:[{name:'square',width:1080,height:1080,format:'webp'},{name:'portrait',width:1080,height:1350,format:'webp'},{name:'story',width:1080,height:1920,format:'webp'}],copy:{titleMax:80,descriptionMax:1200,bulletCount:5,bulletMax:180}},acceptanceChecks:string[],limitations:string[]`. Facts must be grounded in supplied brief; absent facts remain absent. No invented specs, prices, certification or claims. AI must edit the source image preserving product identity; social exports may derive from that AI edit. Deterministic validation does not assert aesthetic quality/factual accuracy.

`POST /api/v2/orders/:jobId/funded {signature?}` -> independently finalized verified V2 order; `GET /api/v2/orders/:jobId`; `GET /api/v2/orders` -> `{orders}` for session wallet. Status adds `submitting`; ready only after durable complete artifacts AND confirmed Submitted with matching result hash. `previews` is array `{name,url,width,height}`, watermarked/low-resolution image URLs. Listing and validation are visible for authenticated buyer review. `GET /api/v2/orders/:jobId/preview/:name` is authenticated. No public originals/static files.

Pack ZIP includes `hero.webp`, `social-square.webp`, `social-portrait.webp`, `social-story.webp`, `listing.json`, `validation.json`, `manifest.json`. Manifest's `artifacts` entries cover the six payload files (self-hash excluded); bundle hash stored separately to avoid circular commitments. A separate committed `previews` array binds the four watermarked review images, sorted by path: `{path,sourcePath,sha256,bytes,width,height,mimeType:'image/webp'}`. Paths are `preview-hero.webp`, `preview-portrait.webp`, `preview-square.webp`, `preview-story.webp`; source paths name their corresponding original artifact. Previews remain outside the seven-file ZIP. The browser verifies each preview's bytes and dimensions before displaying it or permitting approval. This binds the review set without claiming semantic or aesthetic equivalence. Validation object `{schemaVersion:2,passed:boolean,checks:[{name,passed,detail}],limitations:string[]}`. Listing `{title,description,bullets:string[5]}`. Manifest is canonical and result hash commits it. Displayed listing/validation hashes and downloaded bundle payload hashes must match that manifest.

`POST /api/v2/orders/:jobId/challenge {buyer}` and `/download {buyer,nonce,signature}` preserve independent one-time download signing, exact original buyer and finalized Released/manifest binding, persisted consumption and no-store. Authentication may supplement but never replace download ownership proof. Never regenerate submitted/paid output if storage is lost.

AI adapter uses official Responses structured JSON for specification/copy and Image Edits for the hero. Server-only env `OPENAI_API_KEY`, configurable text/image models. Persist attempt ID before chargeable request, provider response/job/request IDs when available, stage and durable returned data before advancing. Bounded timeout/retries only when demonstrably safe; unknown completion after timeout/crash fails pending manual reconciliation, never blindly repeats a chargeable request. Resume from persisted complete stages; reconcile retrievable provider responses when possible. Fixture mode is explicit (`AI_MODE=fixture`) and never evidence of live AI.

The live listing request contains only agreed `productFacts` and copy limits. Its output must use complete approved fact phrases; a conservative lexical guard rejects new content words, changed attribute associations and numeric clauses that do not equal an entire approved fact. Photography directions remain separate. Invalid output fails with 502 before image generation/submission; there is no silent regeneration. This bounded rule does not prove truth, and buyer review remains required. Delivery of an already committed pack uses the original hashes/bytes, without applying a later copy policy to frozen results.

HTTP errors `{error:string,code?:string}`: 400 invalid input, 401 absent/expired/replayed authentication, 403 ownership/origin/signature failure, 409 quote/chain/commitment/state mismatch, 413 upload limit, 429 quota, 502 invalid provider output, 503 provider/chain/storage unavailable. No secrets/provider payloads in client errors. Sensitive responses no-store; exact allowed credentialed CORS origins.

### Frontend and verification

Routes `/` landing; `/demo` explicitly labeled fixture walkthrough, no wallet/fake live claims; `/app` actual V2 checkout; `/recover` compiled trusted configuration/direct RPC only, supports both account versions and always requires original buyer confirmation. Primary actions “Try demo” and “Open workspace”. Product name lowercase osid, positioning “Approve the work. Then release the payment.” Keep raw receipts in details. Preserve existing saved V1 order recovery; do not imply their evidence verifies V2.

Agent handoff: changed files; behavior; commands actually run/results; integration dependencies; remaining risks. Required gates: baseline regression, new client/worker/Rust/local program tests, build/typecheck, real AI runtime, fresh independent review, new Devnet lifecycle and API-offline refund, desktop/mobile evidence, documentation, commit/push and working preview. Lead serializes validator/deployment/stateful rehearsals and owns root lock changes.

---

## Historical V1 reference (Holdfast)

Build spec: `Solana_Hackathon_Execution_Goal.md`. Lead owns this note, root configuration, `packages/chain`, integration scripts, and evidence. Agents must request shared interface changes through the lead.

## Stack and ownership

- Program agent: `programs/checkout/**`, program-specific tests, `Cargo.toml`, `Anchor.toml`. Anchor Rust and TS pinned to **0.31.1**, legacy SPL Token only. Lead provides generated program ID and disposable deployment wallet.
- Worker agent: `apps/worker/**` only. Node 22 + TypeScript + Fastify + sharp; durable local disk. No signing keys in worker.
- Frontend agent: `apps/web/**` only. React 19 + Vite + TypeScript; injected Phantom-compatible wallet. Dedicated `/recover` page requires only RPC and public chain config, never merchant API.
- Lead: root npm workspace and exact dependency pins, `packages/chain/**`, scripts, docs, key generation, builds, integration, Devnet and review gates. Use npm workspaces. Each workspace exports TS source during development; use `tsx` for scripts and worker.

## Chain interface

- Job ID: 32 random bytes, represented as 64 lowercase hex characters in HTTP/JSON; on chain `[u8; 32]`.
- Job PDA seeds: UTF-8 `job`, buyer's 32-byte public key, job ID's 32 bytes. Vault PDA seeds: UTF-8 `vault`, job PDA bytes. Config PDA seeds: UTF-8 `config`.
- Config initializes exactly once and records one mint; initializer restricted to deployment authority. Legacy SPL Token program `TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA`. Six-decimal mock USDC, clearly labeled, for demo.
- `fund(job_id: [u8;32], amount: u64, expires_at: i64)` accounts: `buyer` signer/payer, `merchant` unchecked public key, `config`, `mint`, `buyer_token` ATA, `merchant_token` ATA, `job` init, `vault` init (token authority job), `token_program`, `system_program`. Amount positive, expiry > chain now and <= now + 24h. Bind all fields atomically. Destination ATA must already exist. Job stays after settlement.
- `approve()` accounts: `buyer` signer, `job`, `vault`, `mint`, `merchant_token`, `token_program`. Buyer must equal original; state `Funded`; chain now < expiry. Transfer exactly recorded amount to merchant ATA then set `Released`.
- `refund()` accounts: `buyer` signer, `job`, `vault`, `mint`, `buyer_token`, `token_program`. Buyer must equal original; state `Funded`; chain now >= expiry. Transfer exactly recorded amount to buyer ATA then set `Refunded`.
- Job account fields (order): `buyer: Pubkey`, `merchant: Pubkey`, `mint: Pubkey`, `job_id: [u8;32]`, `amount: u64`, `expires_at: i64`, `state: enum Funded | Released | Refunded`, `bump: u8`, `vault_bump: u8`. Config fields: `authority: Pubkey`, `mint: Pubkey`, `bump: u8`.

## Lead-owned TypeScript client (`@holdfast/chain`)

Exports `PublicConfig {rpcUrl, programId, mint, merchant, decimals:6, amount:"5000000", cluster:"localnet"|"devnet"}` (addresses strings); `Job {address,buyer,merchant,mint,jobId,amount,expiresAt,state,vault}` (addresses and integer amounts strings; expiry epoch seconds number; state exactly `Funded|Released|Refunded`).

Exports `getConnection(config)`, `deriveJobAddress(config,buyer,jobId): PublicKey`, `deriveVaultAddress(config,jobAddress): PublicKey`, `fetchJob(connection,config,address): Promise<Job|null>`, `fetchChainTime(connection): Promise<number>`, `buildFundTransaction(connection,config,{buyer,jobId,expiresAt}): Promise<Transaction>`, `buildApproveTransaction(connection,config,{buyer,jobAddress}): Promise<Transaction>`, `buildRefundTransaction(connection,config,{buyer,jobAddress}): Promise<Transaction>`, `confirmTransaction(connection,signature): Promise<void>`, `explorerUrl(config,signature): string`. Exports web3 `Connection,PublicKey,Transaction`. Worker checks finalized state through `fetchJob` and verifies quote including vault deposit independently. Lead provides checked IDL and account decoder. RPC `finalized` is default read commitment.

## Worker HTTP API (default localhost:8787)

- `GET /health` => `{ok:true}`. `GET /api/config` => `PublicConfig`.
- `POST /api/orders` multipart fields `buyer` (base58), `mode` (`normal` or `stall`), `file` (one PNG, <=5 MB) => `Order` with persisted input and random ID. No processing before verified funding. Server sets expiry chain-now + configured lifetime (default 120 s for rehearsals, env override) and binds quote.
- `Order {jobId,jobAddress,buyer,merchant,mint,amount,expiresAt,mode,status:"quoted"|"funded"|"processing"|"ready"|"released"|"refunded"|"failed",previewUrl?:string,error?:string}`. Preview URL absolute or worker-relative; preview watermarked. No original URL.
- `POST /api/orders/:jobId/funded` body `{signature?:string}` => `Order`. Independently reads finalized chain job, checks all quote fields and funded vault; triggers durable conversion or intentional stall.
- `GET /api/orders/:jobId` => `Order`, reconciles finalized chain state; restarts pending processing after restart. File/result metadata persists before preview becomes ready. `GET /api/orders?buyer=<publickey>` => `{orders:Order[]}` for reconnect recovery (public metadata only).
- `GET /api/orders/:jobId/preview` => watermarked preview only when ready/released.
- `POST /api/orders/:jobId/challenge` body `{buyer:string}` => `{message:string,nonce:string,expiresAt:number}`. Message binds domain, wallet, job ID/address, purpose download, expiry and unique nonce. Short expiry; single use.
- `POST /api/orders/:jobId/download` body `{buyer:string,nonce:string,signature:string}` (base64 Ed25519 signature) => private WebP bytes with attachment filename, only after finalized Released, exact stored order verified and buyer signature validated. `Cache-Control: no-store`. New challenge can recover download after reload. No static private file route.

## Frontend configuration and wallet

`VITE_RPC_URL`, `VITE_PROGRAM_ID`, `VITE_MINT`, `VITE_MERCHANT`, `VITE_CLUSTER`, `VITE_WORKER_URL` compiled into independent client. Checkout may read worker `/api/config` but `/recover` must work with worker unreachable. Persist/recover order ID/address locally; buyer can also paste job address or recovery link. Real transactions signed by connected injected wallet. Optional explicit disposable demo wallet only in local test harness, never hardcoded in product.

Checkout refuses funding if the worker's public RPC/program/mint/merchant/cluster differs from the compiled recovery configuration. A worker reconfiguration must not create a deposit that the independent client is configured to recover on another network.

Download challenge issuance is public. Repeated issuance returns the same still-valid unused challenge and preserves its original expiry. Generate a fresh random nonce after consumption or expiry; public requests cannot invalidate a pending buyer signature.

## Gates / handoff

1. Program builds and local release/refund balances + rejected signer, mint/destination, early refund, late approval, duplicate/repeated/competing actions with unchanged state and token balances.
2. Real PNG conversion, signed download, wrong wallet denied, durable restart/reconnect; UI real wallet release and independent refund with worker stopped.
3. Devnet deployed executable + actual transaction/balance evidence for both flows; clean rehearsal and submission draft. Fresh adversarial review after gate 1.

Handoffs report changed files, working behavior, commands/results, failures and dependencies. No gate may be claimed from fixtures.
