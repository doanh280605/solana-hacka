# Shared interfaces — Holdfast checkout

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
