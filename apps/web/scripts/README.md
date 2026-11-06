# Local draft recording

The browser harness records real local transactions with a disposable wallet injected only by the Node test process. It never puts the private key in the browser. A passing run writes `evidence/ui-localnet.json`, screenshots and the raw checkout/recovery videos. The Phantom extension and Devnet remain separate checks.

Install the small official Playwright recorder into the ignored project directory:

```sh
PLAYWRIGHT_BROWSERS_PATH=.local/playwright node node_modules/playwright-core/cli.js install ffmpeg
```

After deploying/funding localnet, run:

```sh
npx tsx scripts/ui-rehearse.ts localnet
```

The optional `--smoke` flag checks rendering without creating a quote or sending transactions. The harness owns only its child worker/Vite processes, defaults to ports 18788/15173, and requires the Chrome executable at `/Applications/Google Chrome.app/Contents/MacOS/Google Chrome` (override with `UI_CHROME_PATH`). It stops the actual worker and proves connection refusal before testing independent recovery.

To render the current local evidence into a silent draft under two minutes, install a full encoder separately. This pinned extra tool stays outside root package dependencies:

```sh
npm install --prefix .local/ffmpeg-tools --no-package-lock --ignore-scripts=false --no-save ffmpeg-static@5.2.0
node apps/web/scripts/render-demo-draft.mjs
```

Alternatively, use an existing full FFmpeg installation:

```sh
HOLDFAST_FFMPEG_PATH=/absolute/path/to/ffmpeg node apps/web/scripts/render-demo-draft.mjs
```

The renderer requires `drawtext`, `concat`, PNG decoding and H.264 encoding; the small Playwright recorder lacks these. `HOLDFAST_DEMO_FONT` can override the default macOS Arial font. Inputs are the two raw local videos, the passing evidence JSON and the final desktop refund screenshot. The renderer creates `evidence/demo-localnet-draft.mp4` with a “Solana Hackathon” opening, persistent LOCALNET/injected-wallet/mock-USDC labels, and a final hold on the actual settled state. This silent draft is evidence for the local rehearsal, not a final public submission or Devnet recording.
