# Holdfast

Refundable stablecoin checkout for one automated job: PNG to WebP. A buyer deposits **5 mock USDC**, reviews a watermarked preview, and approves payment. At the chain deadline, an unapproved deposit can be refunded by the buyer through a separate recovery page while the merchant API is stopped.

The program enforces payment rules. File processing and delivery depend on merchant storage. Mock USDC is a disposable six-decimal SPL token, not real USDC.

## Setup

Use Node **22.21.1**, npm **10.9.4**, and an installed Rust host toolchain (tested with **1.95.0**). The repository pins Anchor **0.31.1**, Solana **2.1.0**, platform tools **v1.56**, and npm/Cargo lockfiles. The SBF compiler uses Rust **1.89.0-dev**. Anchor's generated IDL is checked in and refreshed after each build.

```sh
nvm use
npm run setup
npm run doctor
npm run build:program
npm run typecheck
npm test
npm run test:rust
```

`setup` installs npm workspaces and official Solana/Anchor binaries under `.tools/`, creates disposable keypairs under ignored `.local/keys/`, aligns the program ID, and writes public API/browser configuration. It does not change your default Solana CLI wallet or cluster. On a new checkout your public addresses differ from this workspace's addresses. Keep `.local/keys` for repeat runs of the same deployment.

The SBF build uses `-Zbuild-std=std,panic_abort` to compile the legacy target with the pinned modern platform compiler. IDL generation runs separately on the host compiler. Automatic IDL account resolution is disabled; runtime PDA/token constraints remain enforced and clients supply every account explicitly. See [program notes](programs/checkout/README.md).

If the coding sandbox blocks network or local port binding for `npm run`, the already-authorized runner in this workspace is `npx tsx scripts/<script>.mjs` or `.ts` (for example, `npx tsx scripts/doctor.mjs`). In a regular terminal, use the npm commands above.

## Run locally

Keep the validator in its own terminal. Its ledger persists between runs; the script does not reset it.

```sh
npm run validator
```

In another terminal:

```sh
npm run deploy:local
npm run test:program
npm run test:review
npm run verify:local
npm run rehearse:local
```

The first deployment creates the mock mint, buyer/merchant token accounts, buyer test tokens, and immutable mint configuration. To exercise fresh-initializer authorization cases on the first deployment, use `npx tsx scripts/deploy.ts localnet --defer-initialize` before `npm run test:program`; those tests initialize the config after proving unauthorized initialization fails. Subsequent runs retain existing config and report initializer tests as not rerun. Repeated verification always uses new job IDs.

Run the two product processes separately:

```sh
npm run dev:worker
```

```sh
npm run dev:web
```

Open `http://localhost:5173`. Connect a Phantom-compatible injected browser wallet. Set the wallet's network/custom RPC to this local validator for local development. Fund that wallet from the disposable deployment wallet:

```sh
npm run fund:wallet -- localnet YOUR_BROWSER_WALLET_PUBLIC_KEY
```

This mints 100 mock USDC and supplies a small amount of test SOL for transaction fees and account rent. Wallet secrets stay in the wallet; this command takes only a public key. The product includes no embedded demo signing key.

Choose one PNG, save the quote, deposit, review the watermarked preview, approve, and sign the download challenge. Reload to recover the order and sign a new challenge for another download. “Stall rehearsal” deliberately suppresses conversion.

## Independent recovery

Save the job address or “Independent recovery” link before stopping the API. Keep Vite/the static frontend running and stop only the worker terminal. Visit:

```text
http://localhost:5173/recover?job=YOUR_JOB_PDA
```

The recovery route uses compiled public settings and direct Solana RPC. It never calls the merchant API. Connect the original buyer and wait until the finalized chain clock reaches the recorded deadline, then sign the refund. The vault pays the recorded buyer's canonical token account. A pasted address or full recovery link also works.

For deployment, build and serve `apps/web/dist` separately from the API, with SPA fallback to `index.html` for `/recover`. A refund cannot run if both the recovery frontend and all RPC access are unavailable; the buyer can also use the direct TypeScript client.

## Devnet

The public RPC currently disables its `requestAirdrop` faucet. Use the official [Solana faucet](https://faucet.solana.com) when required; only **Devnet test SOL** is used.

```sh
npm run keys
npx tsx scripts/prefund.ts devnet
npm run deploy:devnet
npm run verify:devnet
npm run rehearse:devnet
npm run fund:wallet -- devnet YOUR_BROWSER_WALLET_PUBLIC_KEY
```

Fund the printed disposable deployer address with **5 test SOL** for the current build (the latest deployment estimate is about 4.1). `deploy` prints its current requirement, verifies Devnet's genesis hash, waits for finalized deployment, checks onchain bytecode against the compiled artifact, and writes public `.env` and `apps/web/.env.local` settings. Restart/rebuild the frontend and restart the worker after switching clusters. Each cluster uses its own storage directory. Optional `DEVNET_RPC_URL` selects another Devnet endpoint; its genesis is checked before sending.

The officially linked proof-of-work faucet also cannot fund this deployment at the recorded check: claims require an upfront fee, no full-reward pool is profitable, and the only positive partial payout nets about 0.00024 SOL. [Funding evidence](evidence/funding-pow.json). Recheck balances and pool feasibility with `npm run status:devnet` and `npx tsx scripts/pow-fund.mjs`; the latter only reads public accounts and simulates an unsigned transaction, without mining or sending.

The assigned program address in this workspace is `7cW6fScgHCAWBo9YDQEhuS6brFjssJSmomRN11Xa9iKY`. An assigned address alone does not prove a Devnet deployment. Consult the evidence files below. Set `REDEPLOY_PROGRAM=1` to deliberately deploy a changed binary to an existing program; otherwise deployment verifies and reuses the existing bytecode.

## Verification and evidence

| Command | What it proves |
| --- | --- |
| `npm test` | Client boundary/ownership/account checks; real sharp conversion; fixture-based worker authorization, integrity, persistence and replay tests. No chain deployment claim. |
| `npm run test:rust` | Contract boundary/serialization policies on the host. |
| `npm run test:program` | Actual local program rejection/rollback tests, wrong signer/mint/destination, expiry, duplicate funding, repeat and competing settlement, exact transfer and vault surplus. Full state/token bytes compared; SOL fees excluded. |
| `npm run test:review` | Fresh local review: ten failed transactions actually land, including competing settlements in one transaction; token/job/rent rollback and separately charged fees, plus real-chain private-download regressions. |
| `npm run verify:local` / `verify:devnet` | Real client fund/release and fund/refund, job states, token balance deltas, signatures, fees and explorer links. |
| `npm run rehearse:local` / `rehearse:devnet` | Real PNG purchase, durable original before preview, signed download, second-wallet denial, process restart, and refund with the owned API process exited and its port refusing connections. |
| `npx tsx scripts/ui-rehearse.ts localnet` (or `devnet`) | Browser flows with a disposable injected test wallet signing actual chain transactions; screenshots/video when supported. Actual Phantom extension approval remains a separate manual check. |

Evidence is written under `evidence/`: `deployment-<cluster>.json`, `verify-<cluster>.json`, `rehearsal-<cluster>.json`, browser evidence, and the local program TAP report. Progress checkpoints preserve every funded job's address/recovery link even if later steps fail. Never treat a `*-blocked.json`, progress file, fixture test, or local result as Devnet success.

The live local adversarial suite can also target a disposable Devnet test deployment by setting `ANCHOR_PROVIDER_URL` and `CHECKOUT_TEST_ALLOW_DEVNET=1`; it verifies the genesis hash before sending. It creates additional mock tokens/accounts and consumes test SOL.

## Layout and public interfaces

- `programs/checkout`: Anchor program and live adversarial tests.
- `packages/chain`: generated IDL, finalized account reader and transaction builders shared by browser/worker/scripts.
- `apps/worker`: durable PNG conversion and signed private delivery. [Worker runbook](apps/worker/README.md).
- `apps/web`: checkout and API-independent recovery client.
- `scripts`: setup, deployment, balance evidence and complete rehearsals.
- [Shared interface](docs/INTERFACES.md), [demo script](docs/DEMO.md), [submission draft and verified deadlines](docs/SUBMISSION.md), [execution status](docs/STATUS.md).

Job IDs are 32 random bytes, encoded as 64 lowercase hex characters. Job PDA seeds are `job`, buyer, job ID; vault PDA seeds are `vault`, job address. Terminal records remain on chain so no job ID can be reinitialized for that buyer. Only legacy SPL Token and the configured six-decimal mock mint are accepted. Approval requires chain time strictly before expiry; refund permits equality and later.

The program is upgradeable by the disposable deployer and has not had a production audit. It retains account rent and accidental vault surplus. One worker process owns each storage directory; private files and challenge state are never served statically. Delivery authorization requires finalized `Released`, the exact saved order/file manifests, and an expiring single-use signature from the original buyer.

The user owns final publishing and MLH submission. No repository, app or video visibility is changed by these scripts. AI assistance is disclosed in [the submission draft](docs/SUBMISSION.md).
