# osid

**Approve the work. Then release the payment.**

Upload a product photograph and a brief. Agree to a fixed product-listing pack, deposit **5 mock USDC** into Solana escrow, review the generated work, and explicitly approve payment. If you do not approve, the original buyer can reclaim the recorded deposit at the chain deadline, including while the service API is offline.

The pack contains one AI-edited 1600 × 1600 hero, social exports at 1080 × 1080, 1080 × 1350 and 1080 × 1920, listing copy, a deterministic validation report, an artifact manifest and a ZIP bundle. Copy limits: title 80 characters, description 1200, five bullets of at most 180 characters each. Seller facts ground the copy; image edits must preserve product identity. Buyer review is still necessary.

This is a Devnet prototype using a disposable six-decimal SPL mock token. It has no real USDC value. Hashes bind agreed terms and artifact bytes; they do not prove subjective AI quality, factual correctness or permanent file availability.

Current verification: **90 unit, 10 Rust and 39 actual local-program tests pass**, with typechecks, production build, Devnet settlement/recovery and independent review. Runtime AI has produced real specifications, edited images and copy. **A successful live AI approval/download remains unverified** after RPC interruptions and large host/execution delays. All five funded live attempts were refunded; an uncertain image attempt is preserved without regeneration. Credentials are configured. The managed preview is http://localhost:5173/ in live mode on Devnet; [status](docs/STATUS.md) records evidence, current limitations and process instructions.

## Start

Pinned baseline tools: Node 22.21.1, npm 10.9.4, Anchor 0.31.1, Solana CLI 2.1.0, platform tools v1.56; tested host Rust 1.95.0. Existing toolchains and lockfiles remain in use.

```sh
nvm use
npm run setup
npm run doctor
npm run build:program
npm run keys
npx tsx scripts/osid-keys.mjs
```

Setup installs pinned dependencies/toolchains and generates disposable ignored keys. It never changes the default CLI wallet or cluster. Keep `.local/keys` across deployments. The dedicated `provider.json` signs result submissions only; the worker must never load a buyer or program upgrade-authority key.

Configure an existing funded OpenAI account in the ignored root `.env`:

```dotenv
AI_MODE=live
OPENAI_API_KEY=YOUR_EXISTING_KEY
OPENAI_TEXT_MODEL=gpt-4.1-mini
OPENAI_IMAGE_MODEL=gpt-image-1.5
PROVIDER_KEYPAIR_PATH=.local/keys/provider.json
OSID_ORDER_LIFETIME_SECONDS=1800
OSID_QUOTE_LIFETIME_SECONDS=600
```

Use `.env.example` and `apps/web/.env.example` for all public settings. Never put credentials or signing keys in `VITE_` variables. Configuration generation preserves server-only custom environment entries. [Provider setup and failure recovery](docs/AI-PROVIDER.md).

An explicit `AI_MODE=fixture` enables deterministic development fixtures. `/demo` uses labeled synthetic samples without a wallet. Neither fixtures nor assistant-created sample artwork demonstrate application runtime AI. Live mode fails clearly if credentials are absent; it never silently falls back.

## Local chain and preview

Keep the validator in one terminal. This separate ledger preserves historical V1 runs:

```sh
npx tsx scripts/validator.mjs --ledger .local/ledger-osid
```

In another terminal, deploy the built program and create the mock mint/accounts:

```sh
npx tsx scripts/deploy.ts localnet --osid --defer-initialize
npx tsx scripts/osid-program-tests.ts
```

The V1 suite initializes the immutable config after testing initializer authorization. On subsequent deployments omit `--defer-initialize`; repeated suites use fresh job IDs and report initializer cases that could not be rerun.

For a managed preview:

```sh
npx tsx scripts/preview.ts start
```

Use `start --fixture` explicitly for a development preview without live credentials. Stop only its verified recorded processes with `npx tsx scripts/preview.ts stop`.

The development server serves only browser sources, the shared client and their dependencies. Private runtime files, inputs, keypairs and environment files are denied, including public-directory symlink aliases. Keep worker data outside `apps/web/public`; the worker has no public artifact directory.

Alternatively start the two product processes separately:

```sh
npm run dev:worker
```

```sh
npm run dev:web
```

- Landing: http://localhost:5173/
- Labeled sample: http://localhost:5173/demo
- Working service: http://localhost:5173/app
- Independent recovery: http://localhost:5173/recover
- Worker health: http://localhost:8787/health

Connect a Phantom-compatible wallet configured for the same network. Sign-in requires a separate wallet message signature; connecting alone does not authenticate. Fund its public address with disposable test tokens:

```sh
npm run fund:wallet -- localnet YOUR_WALLET_PUBLIC_KEY
```

Upload a PNG/JPEG/WebP of at most 5 MiB and 4096 × 4096 pixels, enter a 20–2000-character brief, review the exact quote/specification, then fund. Quote validity is 10 minutes; the separate execution/refund deadline is 30 minutes after quoting. Funding, payment approval, download authorization and refunds are separate wallet confirmations.

Live copy uses complete agreed fact phrases; conservative guards preserve measurement subjects and reject unsupported wording. They can reject valid paraphrases and cannot prove truth. The worker persists the entire pack before submitting its manifest hash. Preview readiness requires the durable pack and finalized chain submission to agree. Approval binds the exact frozen result hash and releases exactly 5,000,000 token base units to the recorded merchant. A download requires finalized release and a separate expiring single-use buyer signature.

Stop each foreground process with Ctrl-C in its own terminal. Do not kill generic Node processes. A managed preview, when started by the agent, records exact owned PIDs/logs in `.local/osid-preview.json`; use its documented stop command. The validator ledger persists; no command above resets it.

## API-independent refunds

Save the job address/recovery link before stopping the worker. Keep the static frontend and RPC reachable, stop only the worker, then open:

```text
http://localhost:5173/recover?job=JOB_ADDRESS
```

Recovery uses compiled trusted configuration and direct Solana RPC. It loads no merchant API or authentication endpoint. Both legacy V1 and new V2 deposits remain readable. The original buyer authorizes the refund; it is available at or after the finalized chain deadline from Funded or Submitted. Refunds are not automatic. Released and Refunded are terminal.

Static hosting must serve `index.html` for `/`, `/demo`, `/app` and `/recover`. Recovery frontend/RPC availability is still required; the shared TypeScript client can also build direct refunds. [Interfaces and commitment encoding](docs/INTERFACES.md).

## Checks and rehearsals

```sh
npm run typecheck
npm test
npm run test:rust
npm run build
npx tsx scripts/osid-program-tests.ts
npm run check:osid
npx tsx scripts/osid-rehearse.ts localnet --fixture
npx tsx scripts/osid-ui-rehearse.ts localnet --fixture
```

Remove `--fixture` for real runtime AI verification. Use `--review-gate` for the live browser run so an operator inspects the exact submitted pack before the disposable buyer signs approval. Rehearsals use isolated private storage and unique jobs. They start/stop only their own API processes; the local validator must already be running. The HTTP rehearsal verifies full bundle contents independently, buyer/session/download replay protections, exact token deltas and an API-offline refund. The browser rehearsal records desktop/mobile behavior and direct recovery with zero merchant requests. Its disposable injected wallet is a test harness, not a Phantom extension test.

The serial program-test wrapper supplies the configured existing mock mint; direct suites remain available for isolated fresh-mint tests. If this macOS iCloud workspace evicts generated Cargo cache files, keep the repository downloaded and rerun host checks with a local cache outside iCloud, for example `CARGO_TARGET_DIR=/private/tmp/osid-host-target npm run check:osid`. This changes build storage, not the program source. The current verified local validator uses `.local/ledger-osid-v2`; it cloned the public Devnet mint with `--clone-devnet-mint` because a legacy private mint key had been evicted. Do not reset historical ledgers or replace existing keys.

## Devnet

```sh
npx tsx scripts/deploy.ts devnet --osid --upgrade
npx tsx scripts/osid-rehearse.ts devnet
npx tsx scripts/osid-ui-rehearse.ts devnet
npm run fund:wallet -- devnet YOUR_WALLET_PUBLIC_KEY
```

Use only disposable Devnet SOL. Scripts verify the cluster genesis, program identity, finalized deployment and exact bytecode before writing runtime settings. Switching clusters requires worker restart and frontend restart/rebuild. Existing V1 instructions/accounts are preserved alongside V2; do not reinterpret old bytes.

Program: `7cW6fScgHCAWBo9YDQEhuS6brFjssJSmomRN11Xa9iKY`.
Mock mint: `4jMjhk5ZyqnED6BtbQwiqNmcuzMJmti83nEPsceUtN7C`.

Keep the computer awake and online throughout a live rehearsal. Chain deadlines continue while a local host is suspended. Never extend an existing job or repeat an uncertain chargeable image request to conceal a failed run.

An interrupted upload must reuse its existing loader buffer. Inspect buffers before retrying and resume with `--buffer PUBLIC_BUFFER_ADDRESS`; never allocate repeated buffers blindly. [Historical deployment runbook](docs/HOLDFAST-V1.md) describes exact resume commands. No mainnet funds, production publish, default-branch merge or hackathon submission is part of these scripts.

## Evidence and boundaries

[Current status](docs/STATUS.md), [implementation checklist](docs/OSID-IMPLEMENTATION.md), [architecture](docs/ARCHITECTURE.md), [review](docs/REVIEW.md), [demo script](docs/DEMO.md), [submission draft and AI disclosure](docs/SUBMISSION.md).

New osid evidence uses `evidence/osid-*`. Files without that prefix are historical Holdfast V1 evidence from `eca59b5`; they do not establish V2 behavior or live AI. The [V1 README](docs/HOLDFAST-V1.md) and original execution goal remain available as a fallback.

The program is upgradeable and unaudited. Files depend on service storage; one worker owns a storage directory. Rent and accidental vault surplus remain locked. Session expiration does not affect independent recovery. Ambiguous provider timeouts/crashes do not trigger blind chargeable regeneration. Provider bonds, arbitration, marketplaces, identity registries and autonomous spending are deferred.
