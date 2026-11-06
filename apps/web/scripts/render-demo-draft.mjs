import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { access, lstat, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const DEVNET_GENESIS = 'EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG';
const MAINNET_GENESIS = '5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp';
const WIDTH = 1440;
const HEIGHT = 1000;
const BANNER = 120;
const TITLE_SECONDS = 4;
const FINAL_SECONDS = 5;

export function sourcePaths(cluster) {
  assert(cluster === 'localnet' || cluster === 'devnet', 'Choose localnet or devnet.');
  return {
    evidence: `evidence/ui-${cluster}.json`,
    checkout: `evidence/ui-${cluster}-checkout.webm`,
    recovery: `evidence/ui-${cluster}-recovery.webm`,
    final: `evidence/screenshots/ui-${cluster}-desktop-refunded.png`,
    video: `evidence/demo-${cluster}-draft.mp4`,
    metadata: `evidence/demo-${cluster}-draft.json`,
  };
}

export function validateEvidence(evidence, cluster) {
  const paths = sourcePaths(cluster);
  assert(evidence.passed === true && evidence.stage === 'passed' && evidence.cluster === cluster,
    `A passing ${cluster} browser rehearsal matching the requested cluster is required.`);
  assert(typeof evidence.runId === 'string' && Number.isFinite(Date.parse(evidence.startedAt))
    && Number.isFinite(Date.parse(evidence.finishedAt)), 'The browser evidence must identify a completed run.');
  if (cluster === 'devnet') assert.equal(evidence.genesis, DEVNET_GENESIS, 'Evidence does not identify the real Devnet genesis.');
  else {
    assert(evidence.genesis && ![DEVNET_GENESIS, MAINNET_GENESIS].includes(evidence.genesis), 'Local footage must identify a local chain.');
    assert(['localhost', '127.0.0.1', '[::1]'].includes(new URL(evidence.rpcUrl).hostname), 'Local footage must use a loopback RPC.');
  }
  assert.equal(evidence.amount, '5000000', 'The demo must record a 5 mock-USDC payment.');
  assert.equal(evidence.decimals, 6);
  assert.equal(evidence.privateKeysInBrowser, false, 'The browser signing boundary must be recorded.');
  assert(Array.isArray(evidence.pageErrors) && evidence.pageErrors.length === 0, 'The browser run must have no page errors.');
  assert(Array.isArray(evidence.merchantRequestsOnRecovery) && evidence.merchantRequestsOnRecovery.length === 0,
    'Independent recovery must record zero merchant requests.');
  assert(evidence.artifacts?.videos?.includes(paths.checkout) && evidence.artifacts.videos.includes(paths.recovery),
    'Both recordings must be listed as artifacts of this cluster-specific run.');
  assert(evidence.artifacts?.screenshots?.includes(paths.final), 'The final screenshot must belong to this cluster-specific run.');

  for (const [name, state] of [['release', 'Released'], ['refund', 'Refunded']]) {
    const scenario = evidence[name];
    assert(scenario?.order && scenario.fundedJob && scenario.settledJob, `${name}: finalized job evidence is missing.`);
    for (const job of [scenario.order, scenario.fundedJob, scenario.settledJob]) {
      for (const field of ['buyer', 'merchant', 'mint', 'amount']) {
        assert.equal(job[field], evidence[field], `${name}: ${field} differs from the recorded run.`);
      }
      assert.equal(job.jobId, scenario.order.jobId, `${name}: job ID mismatch.`);
    }
    assert.equal(scenario.fundedJob.state, 'Funded');
    assert.equal(scenario.settledJob.state, state);
    assert.equal(scenario.fundedJob.address, scenario.order.jobAddress);
    assert.equal(scenario.settledJob.address, scenario.order.jobAddress);
    const amount = BigInt(evidence.amount);
    const before = scenario.before;
    const funded = scenario.afterFund;
    const after = scenario.after;
    assert(before && funded && after, `${name}: token balance evidence is missing.`);
    assert.equal(BigInt(before.vault), 0n);
    assert.equal(BigInt(before.buyer) - BigInt(funded.buyer), amount);
    assert.equal(BigInt(funded.merchant), BigInt(before.merchant));
    assert.equal(BigInt(funded.vault), amount);
    assert.equal(BigInt(after.vault), 0n);
    assert.equal(BigInt(after.buyer), BigInt(state === 'Released' ? funded.buyer : before.buyer));
    assert.equal(BigInt(after.merchant), BigInt(before.merchant) + (state === 'Released' ? amount : 0n));
    for (const transaction of [scenario.fund, scenario.settlement]) {
      assert(transaction && /^[1-9A-HJ-NP-Za-km-z]{80,100}$/.test(transaction.signature), `${name}: real transaction signatures are required.`);
      const explorer = new URL(transaction.explorer);
      assert.equal(explorer.hostname, 'explorer.solana.com');
      assert.equal(explorer.pathname, `/tx/${transaction.signature}`);
      assert.equal(explorer.searchParams.get('cluster'), cluster === 'devnet' ? 'devnet' : 'custom');
    }
  }
  assert.equal(evidence.refund.merchantRequestsOnRecovery, 0);
  for (const stage of ['apiOfflineBeforeRecovery', 'apiOfflineAtRefund', 'apiOfflineAfterRefund']) {
    const observation = evidence.refund[stage];
    assert(observation?.health === 'ECONNREFUSED' && observation.exit, `${stage}: an exited API and refused connection must be recorded.`);
    assert(Number.isSafeInteger(observation.pid) && observation.pid > 0 && Number.isFinite(Date.parse(observation.exit.at)),
      `${stage}: the API PID and observed exit timestamp must be recorded.`);
    assert(evidence.processes?.some((process) => process.pid === observation.pid && process.exit), `${stage}: API exit must match an owned process.`);
  }
  return paths;
}

export function proofCaptions(evidence, plan) {
  const original = evidence.release.resultPersistedBeforeApproval;
  const originalSavedBeforeApproval = original?.onchainState === 'Funded'
    && Number.isSafeInteger(original.bytes) && original.bytes > 0
    && typeof original.sha256 === 'string' && /^[a-f0-9]{64}$/.test(original.sha256);
  const api = evidence.refund.apiOfflineAtRefund;
  const playback = (speed) => speed > 1.001 ? ` | Playback ${speed.toFixed(2)}x` : '';
  return {
    checkout: `${originalSavedBeforeApproval ? '1/2 Original saved before approval | Preview, release, download, reconnect' : '1/2 Deposit, preview, approval, signed download, reconnect'}${playback(plan.checkoutSpeed)}`,
    recovery: `2/2 API PID ${api.pid} exited | ECONNREFUSED | 0 merchant requests${playback(plan.recoverySpeed)}`,
    originalSavedBeforeApproval,
    api: { pid: api.pid, observedExitAt: api.exit.at, health: api.health, merchantRequestsOnRecovery: evidence.refund.merchantRequestsOnRecovery },
  };
}

export function renderingPlan(checkoutSeconds, recoverySeconds) {
  assert(Number.isFinite(checkoutSeconds) && checkoutSeconds > 0 && Number.isFinite(recoverySeconds) && recoverySeconds > 0,
    'Both recordings must have finalized, positive media durations.');
  const checkoutSpeed = Math.max(1, checkoutSeconds / 64);
  const recoverySpeed = Math.max(1, recoverySeconds / 42);
  return {
    checkoutSpeed, recoverySpeed,
    expectedDurationSeconds: TITLE_SECONDS + checkoutSeconds / checkoutSpeed + recoverySeconds / recoverySpeed + FINAL_SECONDS,
  };
}

async function command(executable, args) {
  return new Promise((accept, reject) => {
    const child = spawn(executable, args, { cwd: ROOT, stdio: ['ignore', 'ignore', 'pipe'] });
    let log = '';
    child.stderr.on('data', (chunk) => { log = (log + chunk).slice(-32000); });
    child.once('error', reject);
    child.once('exit', (code) => accept({ code, log }));
  });
}

async function inspectMedia(ffmpeg, path, durationRequired = true) {
  const result = await command(ffmpeg, ['-hide_banner', '-i', resolve(ROOT, path)]);
  assert(result.code === 1 && result.log.includes('At least one output file'), `Cannot inspect ${path}: ${result.log}`);
  const dimensions = result.log.match(/Video:[^\n]*?\b(\d{3,5})x(\d{3,5})\b/);
  assert(dimensions, `No video/image dimensions found in ${path}.`);
  const duration = result.log.match(/Duration: (\d+):(\d+):(\d+(?:\.\d+)?)/);
  assert(!durationRequired || duration, `${path} has no finalized duration. Wait for the recorder to close; do not render partial footage.`);
  return {
    width: Number(dimensions[1]), height: Number(dimensions[2]),
    durationSeconds: duration ? Number(duration[1]) * 3600 + Number(duration[2]) * 60 + Number(duration[3]) : null,
  };
}

function tokens(amount) {
  const value = BigInt(amount);
  const fraction = (value % 1000000n).toString().padStart(6, '0').replace(/0+$/, '').padEnd(2, '0');
  return `${value / 1000000n}.${fraction}`;
}

async function main() {
  const args = process.argv.slice(2);
  assert(args.length <= 2 && args.every((arg) => arg === '--check' || arg === 'localnet' || arg === 'devnet'),
    'Usage: node apps/web/scripts/render-demo-draft.mjs [localnet|devnet] [--check]');
  assert(args.filter((arg) => arg !== '--check').length <= 1 && args.filter((arg) => arg === '--check').length <= 1,
    'Choose one cluster and at most one --check flag.');
  const cluster = args.find((arg) => arg !== '--check') || 'localnet';
  const paths = sourcePaths(cluster);
  const ffmpeg = process.env.HOLDFAST_FFMPEG_PATH || resolve(ROOT, '.local/ffmpeg-tools/node_modules/ffmpeg-static/ffmpeg');
  const font = process.env.HOLDFAST_DEMO_FONT || '/System/Library/Fonts/Supplemental/Arial.ttf';
  let evidence;
  try { evidence = JSON.parse(await readFile(resolve(ROOT, paths.evidence), 'utf8')); }
  catch (error) { throw new Error(`Completed ${cluster} browser evidence is unavailable at ${paths.evidence}. No other cluster will be substituted.`, { cause: error }); }
  validateEvidence(evidence, cluster);
  await access(ffmpeg); await access(font);
  const sources = [];
  for (const path of [paths.checkout, paths.recovery, paths.final]) {
    const stat = await lstat(resolve(ROOT, path));
    assert(stat.isFile() && !stat.isSymbolicLink(), `Source must be the actual recorded file: ${path}`);
    assert(stat.mtimeMs >= Date.parse(evidence.startedAt) - 5000, `${path} predates the passing browser run.`);
    const bytes = await readFile(resolve(ROOT, path));
    sources.push({ path, bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') });
  }
  const checkout = await inspectMedia(ffmpeg, paths.checkout);
  const recovery = await inspectMedia(ffmpeg, paths.recovery);
  const final = await inspectMedia(ffmpeg, paths.final, false);
  for (const video of [checkout, recovery]) assert(video.width === WIDTH && video.height === HEIGHT, 'Expected the recorded 1440x1000 desktop viewport.');
  assert(final.width === WIDTH && final.height >= HEIGHT, 'The final screenshot must contain the actual desktop settled state.');
  const plan = renderingPlan(checkout.durationSeconds, recovery.durationSeconds);
  const captions = proofCaptions(evidence, plan);
  assert(plan.expectedDurationSeconds <= 115.01, 'The playback plan must leave room below two minutes.');
  if (args.includes('--check')) {
    console.log(JSON.stringify({ cluster, evidenceRun: evidence.runId, sources, plan, captions, writesFiles: false }, null, 2));
    return;
  }

  // Labels use fixed text and validated integer amounts. No shell command
  // interpolation is used to launch the encoder.
  const text = (value, x, y, size, color = '#f1eee6') => `drawtext=fontfile=${font}:text='${value}':x=${x}:y=${y}:fontsize=${size}:fontcolor=${color}`;
  const label = `${cluster.toUpperCase()} | Injected disposable test wallet | Mock USDC | Silent draft`;
  const networkLabel = cluster === 'devnet'
    ? 'Actual Solana Devnet transactions. Test tokens have no real dollar value.'
    : 'Actual local chain transactions. This recording is not Devnet footage.';
  const title = [
    `color=c=0xf1eee6:s=${WIDTH}x${HEIGHT + BANNER}:r=25:d=${TITLE_SECONDS}`,
    text('Solana Hackathon', 90, 240, 52, '#262721'), text('Holdfast', 90, 325, 110, '#c7431f'),
    text('Good work. Then payment.', 94, 480, 39, '#262721'),
    text(label, 94, 575, 23, '#515547'), text(networkLabel, 94, 625, 23, '#515547'), 'setsar=1',
  ].join(',');
  const segment = (input, subtitle, speed = 1) => `${input}setpts=(PTS-STARTPTS)/${speed.toFixed(8)},fps=25,pad=iw:ih+${BANNER}:0:${BANNER}:color=0x262721,${text('Solana Hackathon / Holdfast', 28, 15, 29)},${text(label, 28, 55, 19, '#c9cdbd')},${text(subtitle, 28, 86, 18, '#eea280')},setsar=1`;
  const settled = evidence.refund.after;
  const finalLabel = `Finalized refund | Buyer ${tokens(settled.buyer)} | Vault ${tokens(settled.vault)} | Merchant ${tokens(settled.merchant)}`;
  const cropY = Math.min(350, final.height - HEIGHT);
  const filter = [
    `${title}[title]`,
    `${segment('[0:v]', captions.checkout, plan.checkoutSpeed)}[checkout]`,
    `${segment('[1:v]', captions.recovery, plan.recoverySpeed)}[recovery]`,
    `${segment(`[2:v]crop=${WIDTH}:${HEIGHT}:0:${cropY},`, finalLabel)}[final]`,
    '[title][checkout][recovery][final]concat=n=4:v=1:a=0[out]',
  ].join(';');
  const temporary = resolve(ROOT, `evidence/demo-${cluster}-draft.render-${process.pid}.mp4`);
  try {
    const rendered = await command(ffmpeg, ['-hide_banner', '-y', '-i', resolve(ROOT, paths.checkout), '-i', resolve(ROOT, paths.recovery),
      '-loop', '1', '-t', String(FINAL_SECONDS), '-i', resolve(ROOT, paths.final), '-filter_complex', filter, '-map', '[out]', '-an', '-t', '119',
      '-c:v', 'libx264', '-preset', 'fast', '-crf', '21', '-pix_fmt', 'yuv420p', '-movflags', '+faststart', temporary]);
    assert.equal(rendered.code, 0, `Draft rendering failed: ${rendered.log}`);
    const actual = await inspectMedia(ffmpeg, temporary);
    assert(actual.durationSeconds > 0 && actual.durationSeconds <= 119, 'Rendered draft must be shorter than two minutes.');
    assert(Math.abs(actual.durationSeconds - plan.expectedDurationSeconds) < 0.2, 'Rendered duration does not match the complete playback plan.');
    const bytes = await readFile(temporary);
    await rename(temporary, resolve(ROOT, paths.video));
    const metadata = {
      createdAt: new Date().toISOString(), artifact: paths.video, cluster,
      evidence: paths.evidence, evidenceRun: evidence.runId, genesis: evidence.genesis,
      sources, sourceDurationsSeconds: [checkout.durationSeconds, recovery.durationSeconds],
      playback: plan, captions, titleSeconds: TITLE_SECONDS, finalStateStillSeconds: FINAL_SECONDS,
      media: { ...actual, codec: 'H.264', audio: false, bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') },
      labels: ['Solana Hackathon', label, networkLabel],
      scope: `Silent ${cluster} rehearsal draft using the matching actual browser recordings and an injected disposable wallet. This does not verify the Phantom extension and is not a public submission.`,
    };
    await writeFile(resolve(ROOT, paths.metadata), JSON.stringify(metadata, null, 2) + '\n');
    console.log(JSON.stringify(metadata, null, 2));
  } finally { await unlink(temporary).catch((error) => { if (error.code !== 'ENOENT') throw error; }); }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch((error) => { console.error(error.message); process.exitCode = 1; });
}
