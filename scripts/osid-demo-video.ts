import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { once } from 'node:events';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve, relative } from 'node:path';
import { chromium } from 'playwright-core';
import { ROOT, clusterArg, writeEvidence } from './common.js';

const cluster=clusterArg(), fixture=process.argv.includes('--fixture');
const sourceName=`osid-ui-${cluster}${fixture?'-fixture':''}`;
const record=JSON.parse(await readFile(resolve(ROOT,`evidence/${sourceName}.json`),'utf8'));
assert.equal(record.passed,true);assert.equal(record.aiMode,fixture?'fixture':'live');assert.equal(record.config.cluster,cluster);
assert.equal(record.recoveryRequests.length,0);assert.equal(record.refund.refundedJob.state,'Refunded');
const duration=108, directory=resolve(ROOT,`.local/osid-demo-${cluster}${fixture?'-fixture':''}`);
await mkdir(directory,{recursive:true});
const output=resolve(ROOT,`evidence/osid-demo-${cluster}${fixture?'-fixture':''}.webm`);
const ffmpeg=process.env.OSID_FFMPEG_PATH??resolve(ROOT,'.local/playwright/ffmpeg-1011/ffmpeg-mac');
const encoder=spawn(ffmpeg,['-y','-loglevel','error','-f','image2pipe','-vcodec','mjpeg','-framerate','1','-i','pipe:0','-an','-c:v','libvpx','-b:v','900k','-r','20',output],{stdio:['pipe','ignore','pipe']});
let encoderErrors='';encoder.stderr.on('data',chunk=>{encoderErrors+=chunk.toString();});
const finished=once(encoder,'close');void finished.catch(()=>{});
encoder.stdin.on('error',()=>{});
const browser=await chromium.launch({headless:true,executablePath:process.env.UI_CHROME_PATH??'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'});
const page=await browser.newPage({viewport:{width:1280,height:720}});
const mode=fixture?'FIXTURE AI · NOT LIVE GENERATION':'LIVE RUNTIME AI';
const network=cluster==='devnet'?'DEVNET':'LOCAL VALIDATOR';
const escape=(value:string)=>value.replace(/[&<>"']/g,char=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[char]!));
const shot=(name:string)=>`evidence/screenshots/${sourceName}-${name}.png`;
const scenes=[
  {seconds:12,title:'Approve the work.',subtitle:'Then release the payment.',body:'A product-listing service for small sellers. One photo, a clear agreement, and the buyer’s final say.',image:shot('landing-desktop'),offset:0},
  {seconds:12,title:'A useful sample, clearly labeled.',subtitle:'No wallet. No live transactions.',body:'The walkthrough shows the brief, fixed specification, previews, validation and sample receipt. Synthetic sample artwork is disclosed.',image:shot('demo-desktop'),offset:250},
  {seconds:14,title:'Agree before depositing.',subtitle:'5 mock USDC. Explicit deliverables.',body:'One 1600² hero. Three social formats. Title, description and five bullets. A validation report, manifest and private ZIP. Quote and refund deadlines are separate.',image:shot('agreement'),offset:520},
  {seconds:16,title:'Review the actual submitted pack.',subtitle:'Four previews bound to the receipt.',body:fixture?'This recorded order uses deterministic fixture generation. It proves the escrow and delivery flow, not runtime AI.':'The runtime provider interpreted the brief, edited the source photograph and generated grounded listing copy.',image:shot('review-desktop'),offset:780},
  {seconds:12,title:'Checks support your judgment.',subtitle:'They do not prove quality or truth.',body:'Dimensions, file counts, copy limits and SHA-256 hashes are checked. Review product identity, aesthetics and every claim before approving.',image:shot('review-desktop'),offset:1800},
  {seconds:12,title:'Only the buyer releases payment.',subtitle:'Download the exact committed files.',body:'A separate transaction releases exactly five tokens. A different one-use signature authorizes the private ZIP. Reload and worker restart preserve access.',image:shot('released'),offset:2360},
  {seconds:12,title:'Then stop the merchant API.',subtitle:'Recovery still talks directly to Solana.',body:`Recorded worker PID ${record.refund.apiOfflineAtDeadline.pid} exited. Health probe: ECONNREFUSED. Merchant requests from the recovery page: ${record.recoveryRequests.length}. Original buyer signs the refund.`,image:shot('recovery-before'),offset:300},
  {seconds:10,title:'The deposit comes back.',subtitle:'Exact amount. Finalized Refunded state.',body:'A separate expired order returns 5,000,000 token units to its original buyer. Merchant balance is unchanged. Refunds require a buyer transaction.',image:shot('refunded-desktop'),offset:370},
  {seconds:8,title:'AI creates. The buyer decides.',subtitle:'Solana enforces the payment rules.',body:`${fixture?'Fixture content does not establish runtime AI. ':''}Hashes bind agreement and bytes. Storage availability still matters. Upgradeable, unaudited prototype; no real USDC value.`,image:shot('landing-desktop'),offset:0},
];
assert.equal(scenes.reduce((sum,scene)=>sum+scene.seconds,0),duration);
const manifest:unknown[]=[];
try{
  for(let index=0;index<scenes.length;index++){
    const scene=scenes[index], bytes=await readFile(resolve(ROOT,scene.image));
    await page.setContent(`<!doctype html><html><head><style>*{box-sizing:border-box}body{margin:0;background:#f5f2e8;color:#282d24;font-family:Arial,sans-serif}.top{height:78px;padding:25px 38px;display:flex;justify-content:space-between;border-bottom:1px solid #d2d4c3;font-size:12px;letter-spacing:1.5px}.logo{font-size:28px;font-weight:800;letter-spacing:-2px}.mode{color:#ad3e25}.main{display:grid;grid-template-columns:380px 1fr;gap:30px;padding:35px 38px;height:566px}.text{padding-top:18px}h1{font-size:43px;line-height:1.02;letter-spacing:-1.8px;margin:0 0 25px}h2{font:italic 29px Georgia,serif;color:#b74225;margin:0 0 26px}p{font-size:17px;line-height:1.55;color:#545f4a}.frame{position:relative;overflow:hidden;border:1px solid #d2d4c3;background:#e7eadc}.frame img{width:100%;position:absolute;top:-${scene.offset*(756/1440)}px}.bottom{margin:0 38px;border-top:1px solid #d2d4c3;padding-top:16px;display:flex;justify-content:space-between;font-size:11px;letter-spacing:.7px}</style></head><body><div class="top"><span><b class="logo">osid.</b> &nbsp; SOLANA HACKATHON</span><span class="mode">${network} · ${mode}</span></div><div class="main"><div class="text"><h1>${escape(scene.title)}</h1><h2>${escape(scene.subtitle)}</h2><p>${escape(scene.body)}</p></div><div class="frame"><img src="data:image/png;base64,${bytes.toString('base64')}"></div></div><div class="bottom"><span>RECORDED SCREENSHOT WALKTHROUGH · INJECTED TEST WALLET · MOCK TOKENS · SILENT</span><span>${String(index+1).padStart(2,'0')} / ${scenes.length}</span></div></body></html>`);
    await page.locator('img').evaluate(async(img:HTMLImageElement)=>img.decode());
    const frame=await page.screenshot({type:'jpeg',quality:90});await writeFile(resolve(directory,`scene-${index+1}.jpg`),frame);
    for(let second=0;second<scene.seconds;second++){if(!encoder.stdin.write(frame))await once(encoder.stdin,'drain');}
    manifest.push({...scene,sourceSha256:createHash('sha256').update(bytes).digest('hex')});
  }
  encoder.stdin.end();const[code]=await finished;assert.equal(code,0,encoderErrors);
  const bytes=await readFile(output);
  await writeEvidence(`osid-demo-${cluster}${fixture?'-fixture':''}`,{schemaVersion:2,at:new Date().toISOString(),source:`evidence/${sourceName}.json`,video:relative(ROOT,output),seconds:duration,format:'VP8 WebM,1280x720,20fps,silent',presentation:'Captioned still-frame walkthrough of actual browser captures, not a continuous real-time recording.',aiMode:record.aiMode,wallet:record.wallet,sha256:createHash('sha256').update(bytes).digest('hex'),bytes:bytes.length,scenes:manifest,scope:'Draft artifact only. No video published or hackathon entry submitted.'});
  console.log(`Created ${duration}-second ${fixture?'fixture':'live'} demo ${relative(ROOT,output)}`);
}finally{await page.close();await browser.close();if(encoder.exitCode===null)encoder.kill('SIGTERM');}
