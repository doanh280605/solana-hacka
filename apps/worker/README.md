# Worker

Run from the repository root with the root `.env` prepared:

```sh
npm run dev:worker
npm run typecheck --workspace @holdfast/worker
npm test --workspace @holdfast/worker
```

Node 22 is required. The worker uses Fastify 5.6.2, multipart 9.2.1, sharp 0.34.4, and Node's Ed25519 verification. It has no wallet signing key. Only run one worker process per storage directory.

Required environment: `RPC_URL`, `PROGRAM_ID`, `MINT`, `MERCHANT`, `CLUSTER` (`localnet` or `devnet`). The public quote is exactly `5000000` base units with six decimals (5 mock USDC). Optional settings:

| Variable | Default |
| --- | --- |
| `WORKER_DATA_DIR` | `.local/worker`, relative to the launching directory |
| `WORKER_HOST` | `127.0.0.1` |
| `WORKER_PORT` | `8787` |
| `ORDER_LIFETIME_SECONDS` | `120` (range 5–86400) |
| `CHALLENGE_LIFETIME_SECONDS` | `60` (range 5–300) |
| `WORKER_PUBLIC_ORIGIN` | `http://localhost:8787` (included in signed challenges) |
| `CORS_ORIGINS` | `http://localhost:5173,http://localhost:4173` |

The exact HTTP contract is in `docs/INTERFACES.md`. An upload accepts `buyer`, `mode=normal|stall`, and one `file`, up to 5 MiB. PNGs must decode fully, be single frame, and have each dimension at most 4096 pixels. Filenames supplied by clients never become storage paths.

Inputs, WebP originals, watermarked previews, quote fields, and challenge consumption live under the storage directory. Files are private to the operating-system user. Metadata and files use same-filesystem atomic replacement and `fsync`. Acknowledged quotes already have durable input. Preview readiness requires the original and preview to be persisted and match their recorded SHA-256 hashes. Restart reconciles stored quotes with finalized chain state and resumes interrupted normal conversions. `mode=stall` deliberately never converts, including after restart.

The worker ignores a claimed funding signature as proof. It independently checks the finalized job's address, buyer, merchant, mint, ID, amount, deadline, and vault derivation. It checks the finalized vault's legacy Token Program owner, mint, job authority, initialized state, and balance of at least the quoted amount while funded. Unsolicited surplus does not prevent processing; the program releases only the recorded amount, so surplus can remain locked in the open vault.

Original downloads require finalized `Released`, matching durable quote/files, and a valid Ed25519 signature by the original buyer. Challenges bind the domain, buyer, ID/address, download purpose, expiry, and random nonce. Consumption is persisted before returning bytes and serialized across concurrent requests. Reload recovery uses a fresh signed challenge. There is no static route for input or original files; all responses use `Cache-Control: no-store`.

The tests perform real PNG conversion and route/signature/storage checks against **explicit chain fixtures**. Adapter tests inspect finalized read commitments and the SPL account layout without RPC. They do not establish payment release, refunds, wallet UI behavior, or Devnet success. Those require the root integration/rehearsal scripts and recorded chain transactions. A refund is built by the independent client directly against Solana; the worker offers no refund endpoint and can be stopped for that demonstration. Storage availability is still required for digital delivery after payment release.
