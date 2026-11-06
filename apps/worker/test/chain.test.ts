import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Connection, PublicKey } from '@holdfast/chain';
import { createChainGateway } from '../src/chain.js';
import { TOKEN_PROGRAM } from '../src/types.js';
import { FixtureChain, walletFixture } from './helpers.js';

test('real chain adapter requests finalized vault data and decodes legacy SPL mint, authority, balance, and state', async t => {
  const fixture = new FixtureChain();
  const authority = walletFixture().address;
  const vault = walletFixture().address;
  const data = Buffer.alloc(165);
  Buffer.from(new PublicKey(fixture.config.mint).toBytes()).copy(data, 0);
  Buffer.from(new PublicKey(authority).toBytes()).copy(data, 32);
  data.writeBigUInt64LE(5_000_001n, 64);
  data[108] = 1;
  const original = Connection.prototype.getAccountInfo;
  const requests: unknown[] = [];
  let owner = new PublicKey(TOKEN_PROGRAM);
  Connection.prototype.getAccountInfo = async (_address, commitment) => {
    requests.push(commitment);
    return { data, owner, lamports: 1, executable: false, rentEpoch: 0 };
  };
  t.after(() => { Connection.prototype.getAccountInfo = original; });
  const gateway = createChainGateway(fixture.config);
  assert.deepEqual(await gateway.readVault(vault), {
    address: vault, programOwner: TOKEN_PROGRAM, mint: fixture.config.mint,
    authority, amount: '5000001', initialized: true,
  });
  data[108] = 2;
  assert.equal((await gateway.readVault(vault))!.initialized, false);
  owner = new PublicKey(authority);
  assert.equal((await gateway.readVault(vault))!.initialized, false);
  assert.deepEqual(requests, ['finalized', 'finalized', 'finalized']);
});

test('real chain adapter reads job existence and the Clock sysvar at finalized commitment', async t => {
  const fixture = new FixtureChain();
  const original = Connection.prototype.getAccountInfo;
  const requests: [string, unknown][] = [];
  Connection.prototype.getAccountInfo = async (address, commitment) => {
    requests.push([address.toBase58(), commitment]);
    if (address.toBase58() !== 'SysvarC1ock11111111111111111111111111111111') return null;
    const data = Buffer.alloc(40);
    data.writeBigInt64LE(1_800_000_000n, 32);
    return { data, owner: new PublicKey('11111111111111111111111111111111'), lamports: 1, executable: false, rentEpoch: 0 };
  };
  t.after(() => { Connection.prototype.getAccountInfo = original; });
  const gateway = createChainGateway(fixture.config);
  assert.equal(await gateway.readJob(fixture.config.merchant), null);
  assert.equal(await gateway.getTime(), 1_800_000_000);
  assert.deepEqual(requests, [[fixture.config.merchant, 'finalized'], ['SysvarC1ock11111111111111111111111111111111', 'finalized']]);
});
