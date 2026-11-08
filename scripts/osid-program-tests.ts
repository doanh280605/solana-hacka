import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { getConnection } from '@holdfast/chain';
import { ROOT, assertNetwork, loadConfig, writeEvidence } from './common.js';

const config = await loadConfig('localnet'), connection = getConnection(config);
const genesis = await assertNetwork(connection, config);
const chosen = process.argv.find(arg => arg.startsWith('--suite='))?.split('=')[1];
const suites = [['v1','checkout.test.ts'],['v2','osid-v2.test.ts'],['review-v1','review.test.ts']].filter(([name]) => !chosen || name === chosen);
assert(suites.length, 'Choose --suite=v1|v2|review-v1 or omit for serial full run');
await mkdir(resolve(ROOT, 'evidence'), { recursive: true });
const results: unknown[] = [];
for (const [name, file] of suites) {
  console.log(`Actual local program tests: ${name}`);
  const log = `evidence/osid-program-${name}-localnet.tap`;
  const result = await new Promise<{ code: number | null; output: string }>((accept, reject) => {
    const child = spawn(process.execPath, ['--import','tsx','--test',`programs/checkout/tests/${file}`], {
      cwd: ROOT, env: { ...process.env, ANCHOR_PROVIDER_URL: config.rpcUrl, CHECKOUT_TEST_MINT: config.mint,
        ANCHOR_WALLET: resolve(ROOT,'.local/keys/deployer.json'), CHECKOUT_IDL: resolve(ROOT,'target/idl/checkout.json') },
      stdio: ['ignore','pipe','pipe'],
    });
    let output=''; child.stdout.on('data', chunk => { output+=chunk; }); child.stderr.on('data', chunk => { output+=chunk; });
    child.once('error',reject); child.once('exit',code=>accept({code,output}));
  });
  await writeFile(resolve(ROOT,log),result.output);
  const tests=Number(result.output.match(/^# tests (\d+)$/m)?.[1]??0), passed=Number(result.output.match(/^# pass (\d+)$/m)?.[1]??0);
  results.push({suite:name,log,exitCode:result.code,tests,passed});
  console.log(`${name}: ${passed}/${tests}, exit ${result.code}`);
  if(result.code!==0){console.error(result.output.slice(-7000));process.exitCode=1;break;}
}
await writeEvidence(`osid-program-localnet${chosen?'-'+chosen:''}`,{schemaVersion:2,at:new Date().toISOString(),genesis,config,
  binarySha256:createHash('sha256').update(await readFile(resolve(ROOT,'target/deploy/checkout.so'))).digest('hex'),
  serialExecution:true,results,passed:!process.exitCode});
