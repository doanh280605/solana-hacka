import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { access, readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const ffmpeg = process.env.HOLDFAST_FFMPEG_PATH || resolve(root, '.local/ffmpeg-tools/node_modules/ffmpeg-static/ffmpeg');
const font = process.env.HOLDFAST_DEMO_FONT || '/System/Library/Fonts/Supplemental/Arial.ttf';
const evidence = JSON.parse(await readFile(resolve(root, 'evidence/ui-localnet.json'), 'utf8'));
assert(evidence.passed && evidence.cluster === 'localnet', 'A passing local browser rehearsal is required.');
await access(ffmpeg); await access(font);
const tokens = (amount) => {
  const value = BigInt(amount);
  return `${value / 1000000n}.${((value % 1000000n) / 10000n).toString().padStart(2, '0')}`;
};
const settled = evidence.refund.after;
const finalLabel = `Finalized refund  |  Buyer ${tokens(settled.buyer)}  |  Vault ${tokens(settled.vault)}  |  Merchant ${tokens(settled.merchant)}`;

const text = (value, x, y, size, color = '#f1eee6') => `drawtext=fontfile=${font}:text='${value}':x=${x}:y=${y}:fontsize=${size}:fontcolor=${color}`;
const label = 'LOCALNET | Injected disposable test wallet | Mock USDC | Silent draft';
const title = [
  'color=c=0xf1eee6:s=1440x1120:r=25:d=4',
  text('Solana Hackathon', 90, 240, 52, '#262721'),
  text('Holdfast', 90, 325, 110, '#c7431f'),
  text('Good work. Then payment.', 94, 480, 39, '#262721'),
  text(label, 94, 575, 23, '#515547'),
  text('Actual local chain transactions. Devnet verification is still pending.', 94, 625, 23, '#515547'),
  'setsar=1',
].join(',');
function segment(input, subtitle) {
  return `${input}setpts=PTS-STARTPTS,fps=25,pad=iw:ih+120:0:120:color=0x262721,${text('Solana Hackathon / Holdfast', 28, 15, 29)},${text(label, 28, 55, 19, '#c9cdbd')},${text(subtitle, 28, 86, 18, '#eea280')},setsar=1`;
}
const filter = [
  `${title}[title]`,
  `${segment('[0:v]', '1/2  Deposit, persisted preview, approval, signed download, reconnect')}[checkout]`,
  `${segment('[1:v]trim=duration=34,', '2/2  Merchant API stopped, direct RPC recovery, buyer receives refund')}[recovery]`,
  `${segment('[2:v]crop=1440:1000:0:350,', finalLabel)}[final]`,
  '[title][checkout][recovery][final]concat=n=4:v=1:a=0[out]',
].join(';');
const target = resolve(root, 'evidence/demo-localnet-draft.mp4');
await new Promise((accept, reject) => {
  const child = spawn(ffmpeg, ['-hide_banner', '-y',
    '-i', resolve(root, 'evidence/ui-localnet-checkout.webm'),
    '-i', resolve(root, 'evidence/ui-localnet-recovery.webm'),
    '-loop', '1', '-t', '5', '-i', resolve(root, 'evidence/screenshots/ui-localnet-desktop-refunded.png'),
    '-filter_complex', filter, '-map', '[out]', '-an', '-t', '119',
    '-c:v', 'libx264', '-preset', 'fast', '-crf', '21', '-pix_fmt', 'yuv420p', '-movflags', '+faststart', target,
  ], { cwd: root, stdio: ['ignore', 'ignore', 'pipe'] });
  let log = '';
  child.stderr.on('data', (chunk) => { log = (log + chunk).slice(-16000); });
  child.once('error', reject);
  child.once('exit', (code) => {
    process.stderr.write(log);
    code === 0 ? accept() : reject(new Error(`Draft video rendering failed with code ${code}.`));
  });
});
await writeFile(resolve(root, 'evidence/demo-localnet-draft.json'), JSON.stringify({
  createdAt: new Date().toISOString(), artifact: 'evidence/demo-localnet-draft.mp4',
  sources: ['evidence/ui-localnet-checkout.webm', 'evidence/ui-localnet-recovery.webm', 'evidence/screenshots/ui-localnet-desktop-refunded.png'],
  sourceDurationsSeconds: [54.04, 37.12], recoveryClipSeconds: 34, finalStateStillSeconds: 5, expectedDurationSeconds: 97.04,
  evidenceRun: evidence.runId, cluster: 'localnet',
  labels: ['Solana Hackathon', label, 'Devnet verification is still pending'],
  scope: 'Silent local rehearsal draft, using actual recorded browser transactions and an injected disposable wallet. This is not a Devnet or Phantom-extension demonstration.',
}, null, 2) + '\n');
console.log(target);
