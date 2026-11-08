import assert from 'node:assert/strict';
import { test } from 'node:test';
import { AccountLayout, AccountState, TOKEN_PROGRAM_ID } from '@solana/spl-token';
import { PublicKey, type Connection } from '@holdfast/chain';
import { decodeTokenBalance, fetchTokenBalances } from '../src/token-balances.js';

const mint = new PublicKey(new Uint8Array(32).fill(2));
const authority = new PublicKey(new Uint8Array(32).fill(3));
const different = new PublicKey(new Uint8Array(32).fill(4));
const target = { address: new PublicKey(new Uint8Array(32).fill(5)), mint: mint.toBase58(), authority: authority.toBase58() };
function account(amount: bigint, state = AccountState.Initialized) {
  const data = Buffer.alloc(AccountLayout.span);
  AccountLayout.encode({ mint, owner: authority, amount, delegateOption: 0, delegate: PublicKey.default, state, isNativeOption: 0, isNative: 0n, delegatedAmount: 0n, closeAuthorityOption: 0, closeAuthority: PublicKey.default }, data);
  return { owner: TOKEN_PROGRAM_ID, executable: false, data, lamports: 1, rentEpoch: 0 };
}

test('legacy balance decoder preserves full u64 precision and absent-account zero', () => {
  assert.equal(decodeTokenBalance(account(18_446_744_073_709_551_615n), target), '18446744073709551615');
  assert.equal(decodeTokenBalance(account(5_000_000n, AccountState.Frozen), target), '5000000');
  assert.equal(decodeTokenBalance(null, target), '0');
});

test('legacy balance decoder rejects wrong program, layout, mint, authority and state', () => {
  assert.throws(() => decodeTokenBalance({ ...account(1n), owner: different }, target), /owner or layout/);
  assert.throws(() => decodeTokenBalance({ ...account(1n), executable: true }, target), /owner or layout/);
  assert.throws(() => decodeTokenBalance({ ...account(1n), data: Buffer.alloc(166) }, target), /owner or layout/);
  assert.throws(() => decodeTokenBalance(account(1n), { ...target, mint: different.toBase58() }), /mint, authority or state/);
  assert.throws(() => decodeTokenBalance(account(1n), { ...target, authority: different.toBase58() }), /mint, authority or state/);
  assert.throws(() => decodeTokenBalance(account(1n, AccountState.Uninitialized), target), /mint, authority or state/);
});

test('three receipt balances use one finalized batch request and incomplete results fail closed', async () => {
  let calls = 0;
  const connection = { async getMultipleAccountsInfo(keys: PublicKey[], commitment: unknown) { calls++; assert.equal(keys.length, 3); assert.equal(commitment, 'finalized'); return [account(7n), account(5_000_000n), null]; } } as Pick<Connection, 'getMultipleAccountsInfo'>;
  assert.deepEqual(await fetchTokenBalances(connection, [target, target, target]), ['7', '5000000', '0']);
  assert.equal(calls, 1);
  const incomplete = { async getMultipleAccountsInfo() { return []; } } as Pick<Connection, 'getMultipleAccountsInfo'>;
  await assert.rejects(fetchTokenBalances(incomplete, [target]), /incomplete/);
});
