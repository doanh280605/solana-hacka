# osid escrow program

Pinned stack: Anchor 0.31.1, Solana CLI 2.1.0, platform tools v1.56
(SBF Rust 1.89.0-dev), legacy SPL Token only. Cargo.lock fixes transitive crates.

`initialize` fixes a six-decimal mint once. Its signer must match the upgrade
authority in this executable program's verified ProgramData account. Initialize
before removing the upgrade authority. Config has no update or close path.

V1 and V2 have separate account discriminators, PDA namespaces and state enums.
Every V1 layout/instruction remains unchanged. Each `(version, buyer, job_id)`
creates one permanent job record and one token vault.

V2 (`job_v2`, buyer, job ID) binds immutable schema version 2, buyer, merchant,
provider, mint, amount, execution deadline, quote expiry, input hash,
specification hash and terms hash. `fund_v2` recomputes the domain-separated
SHA-256 terms commitment onchain using the exact binary encoding in
[INTERFACES.md](../../docs/INTERFACES.md). Funding requires an unexpired quote
whose expiry is before the bounded execution deadline. No private input, copy
or credentials go onchain.

`submit_v2` requires the recorded provider signature, a nonzero result-manifest
hash, Funded state and chain time strictly before execution expiry. It freezes
that result once and moves to Submitted. `approve_v2` requires the original
buyer, Submitted state, the exact frozen hash and time strictly before expiry.
`refund_v2` requires the original buyer and permits either Funded or Submitted
at equality/later. Released and Refunded remain terminal. Provider signatures
never approve or refund buyer funds.

V2 account data is 325 bytes plus the 8-byte Anchor discriminator. Field order:
schema version u16, buyer/merchant/provider/mint public keys, job ID, amount u64,
execution expiry i64, quote expiry i64, input/specification/terms/result hashes,
submission time i64, state u8, job/vault bumps u8 each. V2 state discriminants
are Funded=0, Submitted=1, Released=2, Refunded=3. V1's 147-byte payload and
Funded=0, Released=1, Refunded=2 encoding are unchanged.

For historical V1 jobs,
`fund` uses `init`, binds the full quote, and transfers the exact amount atomically.
`approve` requires the original buyer before expiry; `refund` requires that same
buyer at or after expiry. Settlement transfers only the recorded amount to the
recorded recipient's canonical legacy SPL ATA. Terminal records and vaults remain
allocated, preventing reuse. Unsolicited surplus tokens stay in the vault; no
party can redirect them. Rent is not refunded by this demo.

Both versions enforce these exact token, ATA, signer, mint, PDA and vault checks.
Commitments do not prove subjective AI quality or factual correctness.

## Verification

From the repository root, with dependencies and toolchains installed:

```sh
cargo fmt --all -- --check
npm run test:rust
npm run build:program
```

The build wrapper rebuilds the legacy SBF standard library using
`-Zbuild-std=std,panic_abort`, then generates IDL separately with the host Rust
compiler. Solana 2.1.0's bundled Rust 1.79 cannot parse current dependency
manifests. Platform tools v1.56 supplies the newer compiler but its prebuilt
libraries use the renamed SBPF target, so the legacy target requires this explicit
standard library build. The wrapper keeps Cargo and rustup state in `.tools`;
Solana's upstream builder still stores platform archives in `~/.cache/solana`.

Anchor's IDL account resolution is disabled because its 0.31.x token-string
parser fails with current proc-macro dependencies. Clients supply all accounts
explicitly; onchain PDA checks are unchanged.

Start `npm run validator` in another terminal, then deploy with
`npm run deploy:local`. The live TypeScript suite uses `.local/keys/deployer.json` and
`.local/keys/mint.json`; the deployment wallet must have SOL and control the
mock mint's mint authority. If the mint does not yet exist, the suite creates it.
The mint keypair is never logged. A pre-existing immutable config must match it.
If an existing mint was cloned into the local validator, set
`CHECKOUT_TEST_MINT=<public key>` to use that account without its mint secret.
The suite verifies six decimals and that the test payer controls mint authority;
it never fabricates a key or creates a missing mint without its real signer.

To test an already-running local validator after deployment:

```sh
ANCHOR_PROVIDER_URL=http://127.0.0.1:8899 npx tsx --test programs/checkout/tests/checkout.test.ts
ANCHOR_PROVIDER_URL=http://127.0.0.1:8899 npx tsx --test programs/checkout/tests/osid-v2.test.ts
```

For a deployed Devnet instance, explicitly allow Devnet. The suite also verifies
the RPC genesis hash, so an accidental mainnet URL is rejected.

```sh
CHECKOUT_TEST_ALLOW_DEVNET=1 ANCHOR_PROVIDER_URL=https://api.devnet.solana.com npx tsx --test programs/checkout/tests/checkout.test.ts
CHECKOUT_TEST_ALLOW_DEVNET=1 ANCHOR_PROVIDER_URL=https://api.devnet.solana.com npx tsx --test programs/checkout/tests/osid-v2.test.ts
```

The live suite records real transaction signatures and buyer, merchant and vault
token balances. Every rejected transaction checks unchanged job/config data and
all involved token balances; SOL fees and rent are excluded. It covers wrong
initializer, ProgramData, decimals, signer, mint, token program, canonical ATA,
vault substitution, direct vault theft, duplicate funding, early refund, late
approval, exact settlement with surplus, and repeated/competing terminal actions.
Use a fresh deployment with config not yet initialized for initializer
front-running tests; deploy the executable without the config initialization in
`deploy:local` for that check. Reruns state when those checks could not be
repeated. Pure Rust tests cover exact expiry
equality, deadline overflow, terminal states and the shared serialized layout.

The separate V2 live suite uses unique jobs/participants and verifies commitment
tampering, invalid quote/deadline bounds, wrong mint/ATA/provider/merchant/buyer,
pre-submission approval, zero or duplicate submission, changed-result approval,
exact release with surplus, refunds from both pending states, late submission
and approval, and terminal replay. Every failed attempt compares all watched
job/config/token bytes and token balances. Host tests cover exact expiry equality,
all immutable terms fields, a cross-language commitment vector and both layouts.
Serialize live suites with validator/deployment operations.

A source check or pure policy test does not establish that money moved. Gate 1
requires the deployed-program live suite and balances; Gate 3 requires real
Devnet signatures in addition.
