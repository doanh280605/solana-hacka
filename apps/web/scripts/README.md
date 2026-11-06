# Draft recordings

The browser harness records real transactions with a disposable wallet injected only by the Node test process. It never puts the private key in the browser. A passing run writes `evidence/ui-<cluster>.json`, screenshots and the raw checkout/recovery videos. The Phantom extension remains a separate manual check.

Install the official Playwright recorder into the ignored project directory:

```sh
PLAYWRIGHT_BROWSERS_PATH=.local/playwright node node_modules/playwright-core/cli.js install ffmpeg
```

After deploying and funding the requested cluster, the lead runs the real browser rehearsal:

```sh
npx tsx scripts/ui-rehearse.ts localnet
npx tsx scripts/ui-rehearse.ts devnet
```

Run shared-wallet rehearsals sequentially so balance checks do not overlap. The optional `--smoke` flag checks rendering without creating a quote or sending transactions; smoke evidence cannot produce a settlement demo. The harness owns only its child worker/Vite processes, defaults to ports 18788/15173, and requires Chrome at `/Applications/Google Chrome.app/Contents/MacOS/Google Chrome` (override with `UI_CHROME_PATH`). It stops its actual worker and proves connection refusal before independent recovery.

Install the pinned full encoder separately. It stays outside root dependencies:

```sh
npm install --prefix .local/ffmpeg-tools --no-package-lock --ignore-scripts=false --no-save ffmpeg-static@5.2.0
```

Check readiness without writing files, then render the requested cluster:

```sh
node apps/web/scripts/render-demo-draft.mjs localnet --check
node apps/web/scripts/render-demo-draft.mjs localnet
node apps/web/scripts/render-demo-draft.mjs devnet --check
node apps/web/scripts/render-demo-draft.mjs devnet
```

Omitting the cluster defaults to `localnet`. Each command reads only the matching `ui-<cluster>.json`, `ui-<cluster>-checkout.webm`, `ui-<cluster>-recovery.webm` and `screenshots/ui-<cluster>-desktop-refunded.png`. The renderer requires passing browser evidence, matching terminal states and exact token balances, real transaction links, recorded API termination/refusal, zero merchant requests on recovery and finalized media. Devnet also requires the actual Devnet genesis hash. Missing or mismatched footage fails; local footage is never substituted for Devnet.

Outputs are separate: `evidence/demo-localnet-draft.mp4` and `evidence/demo-devnet-draft.mp4`, with a matching JSON manifest containing source hashes, run ID, playback speeds and measured final media metadata. Rendering Devnet never overwrites the local draft. Every video opens with “Solana Hackathon” and keeps the cluster, injected-wallet and mock-USDC disclosures visible. Both complete recordings are replayed, speeding them up when needed with a visible playback label, then holding the actual settled-state screenshot. Total runtime stays below two minutes. A local title explicitly identifies local footage; a Devnet title identifies actual Devnet test transactions.

The recovery caption shows the actual owned API PID, its observed exit, `ECONNREFUSED` and zero merchant requests, using the validated browser evidence. The success caption says “Original saved before approval” only when the evidence records positive persisted bytes, a SHA-256 hash and the job still `Funded` at that point. These are captions over the actual recordings; no terminal footage is invented.

Use an existing full encoder by overriding its path:

```sh
HOLDFAST_FFMPEG_PATH=/absolute/path/to/ffmpeg node apps/web/scripts/render-demo-draft.mjs devnet
```

FFmpeg needs `drawtext`, `concat`, PNG decoding and H.264 encoding; the small Playwright recorder lacks these. `HOLDFAST_DEMO_FONT` can override the default macOS Arial font. These silent drafts are reviewable recordings, not a final public submission. Publishing and submission remain participant actions.
