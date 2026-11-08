import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import test from 'node:test';
import { AnchorProvider, Program, Wallet, type Idl } from '@coral-xyz/anchor';
import BN from 'bn.js';
import { AccountLayout, createAccount, createMint, getAccount, getMint, getOrCreateAssociatedTokenAccount,
  mintTo, transferChecked, TOKEN_PROGRAM_ID } from '@solana/spl-token';
import { ComputeBudgetProgram, Connection, Keypair, PublicKey, SystemProgram, Transaction } from '@solana/web3.js';
import { computeTermsHash } from '../../../packages/chain/src/index.js';

const AMOUNT = 5_000_000n;
async function readKey(path: string): Promise<Keypair> {
  return Keypair.fromSecretKey(Uint8Array.from(JSON.parse(await readFile(resolve(path), 'utf8'))));
}

// Live, isolated V2 jobs. Run after deployment; never concurrently with deployment/reset.
test('osid V2 live escrow: immutable commitments, provider submission, exact buyer settlement and both refunds', { timeout: 300_000 }, async t => {
  const url = process.env.ANCHOR_PROVIDER_URL ?? 'http://127.0.0.1:8899';
  const local = ['localhost', '127.0.0.1'].includes(new URL(url).hostname);
  assert(local || process.env.CHECKOUT_TEST_ALLOW_DEVNET === '1', 'Devnet requires explicit CHECKOUT_TEST_ALLOW_DEVNET=1');
  const payer = await readKey(process.env.ANCHOR_WALLET ?? '.local/keys/deployer.json');
  const mintSigner = process.env.CHECKOUT_TEST_MINT ? null
    : await readKey(process.env.CHECKOUT_MINT_KEYPAIR ?? '.local/keys/mint.json');
  const connection = new Connection(url, 'confirmed');
  if (!local) assert.equal(await connection.getGenesisHash(), 'EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG', 'mainnet is forbidden');
  const provider = new AnchorProvider(connection, new Wallet(payer), { commitment: 'confirmed', preflightCommitment: 'confirmed' });
  const idl = JSON.parse(await readFile(resolve(process.env.CHECKOUT_IDL ?? 'target/idl/checkout.json'), 'utf8')) as Idl;
  const program = new Program(idl, provider);
  assert((await connection.getAccountInfo(program.programId))?.executable, 'deploy the current V2 binary first');
  const methods = program.methods as any, accounts = program.account as any;
  const buyer = Keypair.generate(), merchant = Keypair.generate(), submitter = Keypair.generate(), attacker = Keypair.generate();
  const mint = process.env.CHECKOUT_TEST_MINT ? new PublicKey(process.env.CHECKOUT_TEST_MINT) : mintSigner!.publicKey;
  const [config] = PublicKey.findProgramAddressSync([Buffer.from('config')], program.programId);
  await provider.sendAndConfirm(new Transaction().add(
    SystemProgram.transfer({ fromPubkey: payer.publicKey, toPubkey: buyer.publicKey, lamports: 100_000_000 }),
    SystemProgram.transfer({ fromPubkey: payer.publicKey, toPubkey: submitter.publicKey, lamports: 10_000_000 }),
    SystemProgram.transfer({ fromPubkey: payer.publicKey, toPubkey: attacker.publicKey, lamports: 10_000_000 }),
  ));
  if (!(await connection.getAccountInfo(mint))) {
    assert(mintSigner, 'CHECKOUT_TEST_MINT must already exist; creating a mint requires its real keypair');
    await createMint(connection, payer, payer.publicKey, null, 6, mintSigner);
  }
  const mintInfo = await getMint(connection, mint);
  assert.equal(mintInfo.decimals, 6, 'test mint must use six decimals');
  assert(mintInfo.mintAuthority?.equals(payer.publicKey), 'test payer must control the existing mock mint authority');
  if (!(await connection.getAccountInfo(config))) {
    const loader = new PublicKey('BPFLoaderUpgradeab1e11111111111111111111111');
    const [programData] = PublicKey.findProgramAddressSync([program.programId.toBuffer()], loader);
    await methods.initialize().accountsStrict({ authority: payer.publicKey, mint, config,
      program: program.programId, programData, systemProgram: SystemProgram.programId }).rpc();
  }
  assert((await accounts.config.fetch(config)).mint.equals(mint), 'test mint must match immutable config');
  const wrongMint = await createMint(connection, payer, payer.publicKey, null, 6);
  const buyerToken = (await getOrCreateAssociatedTokenAccount(connection, payer, mint, buyer.publicKey)).address;
  const merchantToken = (await getOrCreateAssociatedTokenAccount(connection, payer, mint, merchant.publicKey)).address;
  const attackerToken = (await getOrCreateAssociatedTokenAccount(connection, payer, mint, attacker.publicKey)).address;
  const wrongBuyerToken = (await getOrCreateAssociatedTokenAccount(connection, payer, wrongMint, buyer.publicKey)).address;
  const wrongMerchantToken = (await getOrCreateAssociatedTokenAccount(connection, payer, wrongMint, merchant.publicKey)).address;
  const nonAtaMerchant = await createAccount(connection, payer, mint, merchant.publicKey, Keypair.generate());
  const nonAtaBuyer = await createAccount(connection, payer, mint, buyer.publicKey, Keypair.generate());
  await mintTo(connection, payer, mint, buyerToken, payer, 100_000_000n);
  await mintTo(connection, payer, wrongMint, wrongBuyerToken, payer, 100_000_000n);
  const watched = [config, mint, wrongMint, buyerToken, merchantToken, attackerToken, wrongBuyerToken,
    wrongMerchantToken, nonAtaMerchant, nonAtaBuyer];
  const signatures: Record<string, string> = {};
  const inputHash = '81'.repeat(32), specHash = '92'.repeat(32), resultHash = 'a3'.repeat(32);
  let transactionSequence = 0;
  // Distinct signed transactions are necessary when exercising terminal replays:
  // resending identical signed bytes is an RPC retry, not a new program invocation.
  const freshBudget = () => ComputeBudgetProgram.setComputeUnitLimit({ units: 500_000 + ++transactionSequence });

  async function now(): Promise<number> {
    const info = await connection.getAccountInfo(new PublicKey('SysvarC1ock11111111111111111111111111111111'), 'confirmed');
    assert(info && info.data.length >= 40, 'Clock sysvar available');
    return Number(info.data.readBigInt64LE(32));
  }
  function addresses(id: string) {
    const [job] = PublicKey.findProgramAddressSync([Buffer.from('job_v2'), buyer.publicKey.toBuffer(), Buffer.from(id, 'hex')], program.programId);
    const [vault] = PublicKey.findProgramAddressSync([Buffer.from('vault'), job.toBuffer()], program.programId);
    return { job, vault };
  }
  async function quote(lifetime = 180, validity = 120) {
    const id = randomBytes(32).toString('hex'), time = await now();
    const expiresAt = time + lifetime, quoteExpiresAt = time + validity;
    const termsHash = await computeTermsHash({ programId: program.programId, jobAddress: addresses(id).job,
      jobId: id, buyer: buyer.publicKey, merchant: merchant.publicKey, provider: submitter.publicKey, mint,
      amount: AMOUNT.toString(), expiresAt, quoteExpiresAt, inputHash, specHash });
    const result = { id, expiresAt, quoteExpiresAt, termsHash };
    watched.push(addresses(id).job, addresses(id).vault);
    return result;
  }
  type Quote = Awaited<ReturnType<typeof quote>>;
  function fund(value: Quote, overrides: Record<string, PublicKey> = {}, changes: Record<string, unknown> = {}) {
    const args = { jobId: value.id, amount: AMOUNT, expiresAt: value.expiresAt, quoteExpiresAt: value.quoteExpiresAt,
      inputHash, specHash, termsHash: value.termsHash, ...changes };
    return methods.fundV2([...Buffer.from(args.jobId as string, 'hex')], new BN(String(args.amount)),
      new BN(Number(args.expiresAt)), new BN(Number(args.quoteExpiresAt)), [...Buffer.from(args.inputHash as string, 'hex')],
      [...Buffer.from(args.specHash as string, 'hex')], [...Buffer.from(args.termsHash as string, 'hex')])
      .preInstructions([freshBudget()]).accountsStrict({ buyer: buyer.publicKey, merchant: merchant.publicKey, provider: submitter.publicKey,
        config, mint, buyerToken, merchantToken, ...addresses(value.id), tokenProgram: TOKEN_PROGRAM_ID,
        systemProgram: SystemProgram.programId, ...overrides }).signers([buyer]).rpc();
  }
  function submit(value: Quote, signer = submitter, hash = resultHash, overrides: Record<string, PublicKey> = {}) {
    return methods.submitV2([...Buffer.from(hash, 'hex')]).preInstructions([freshBudget()]).accountsStrict({ provider: signer.publicKey,
      job: addresses(value.id).job, ...overrides }).signers([signer]).rpc();
  }
  function approve(value: Quote, signer = buyer, hash = resultHash, overrides: Record<string, PublicKey> = {}) {
    return methods.approveV2([...Buffer.from(hash, 'hex')]).preInstructions([freshBudget()]).accountsStrict({ buyer: signer.publicKey,
      ...addresses(value.id), mint, merchantToken, tokenProgram: TOKEN_PROGRAM_ID, ...overrides }).signers([signer]).rpc();
  }
  function refund(value: Quote, signer = buyer, overrides: Record<string, PublicKey> = {}) {
    return methods.refundV2().preInstructions([freshBudget()]).accountsStrict({ buyer: signer.publicKey, ...addresses(value.id), mint,
      buyerToken, tokenProgram: TOKEN_PROGRAM_ID, ...overrides }).signers([signer]).rpc();
  }
  async function snapshot() {
    const infos = await connection.getMultipleAccountsInfo(watched, 'confirmed');
    return Object.fromEntries(watched.map((key, index) => {
      const info = infos[index];
      return [key.toBase58(), info ? { owner: info.owner.toBase58(), executable: info.executable,
        data: info.data.toString('base64'), amount: info.owner.equals(TOKEN_PROGRAM_ID) && info.data.length === AccountLayout.span
          ? AccountLayout.decode(info.data).amount.toString() : undefined } : null];
    }));
  }
  async function rejected(action: () => Promise<unknown>, expected?: RegExp) {
    const before = await snapshot();
    await assert.rejects(action, expected ?? /AnchorError|custom program error|already in use|signature verification|Error processing Instruction/i);
    assert.deepEqual(await snapshot(), before, 'failure must preserve complete account data and every token balance');
  }
  async function balances(value: Quote) {
    const [b, m, v] = await Promise.all([getAccount(connection, buyerToken), getAccount(connection, merchantToken),
      getAccount(connection, addresses(value.id).vault)]);
    return { buyer: b.amount, merchant: m.amount, vault: v.amount };
  }
  async function state(value: Quote) { return Object.keys((await accounts.jobV2.fetch(addresses(value.id).job)).state)[0]; }

  const release = await quote(600, 300);
  await t.test('funding rejects invalid amount/deadlines, expired quote and zero commitments', async () => {
    await rejected(() => fund(release, {}, { amount: 0n }), /InvalidAmount/);
    await rejected(() => fund(release, {}, { expiresAt: release.expiresAt + 86_401 }), /InvalidDeadline/);
    await rejected(() => fund(release, {}, { quoteExpiresAt: 1 }), /QuoteExpired/);
    await rejected(() => fund(release, {}, { quoteExpiresAt: release.expiresAt }), /InvalidDeadline/);
    for (const field of ['inputHash', 'specHash', 'termsHash']) await rejected(() => fund(release, {}, { [field]: '00'.repeat(32) }), /EmptyCommitment/);
  });
  await t.test('funding binds exact specification/input/amount/provider/merchant and canonical mint/accounts', async () => {
    await rejected(() => fund(release, {}, { inputHash: resultHash }), /TermsMismatch/);
    await rejected(() => fund(release, {}, { specHash: resultHash }), /TermsMismatch/);
    await rejected(() => fund(release, {}, { termsHash: resultHash }), /TermsMismatch/);
    await rejected(() => fund(release, {}, { amount: AMOUNT + 1n }), /TermsMismatch/);
    await rejected(() => fund(release, { provider: attacker.publicKey }), /TermsMismatch/);
    await rejected(() => fund(release, { provider: PublicKey.default }), /InvalidProvider/);
    await rejected(() => fund(release, { merchant: attacker.publicKey, merchantToken: attackerToken }), /TermsMismatch/);
    await rejected(() => fund(release, { mint: wrongMint, buyerToken: wrongBuyerToken, merchantToken: wrongMerchantToken }), /WrongMint/);
    await rejected(() => fund(release, { buyerToken: nonAtaBuyer }), /WrongDestination/);
    await rejected(() => fund(release, { merchantToken: nonAtaMerchant }), /WrongDestination/);
    await rejected(() => fund(release, { tokenProgram: SystemProgram.programId }));
  });
  signatures.fund = await fund(release);
  await t.test('funding is exact, records immutable commitments and cannot be replayed', async () => {
    assert.deepEqual(await balances(release), { buyer: 95_000_000n, merchant: 0n, vault: AMOUNT });
    const stored = await accounts.jobV2.fetch(addresses(release.id).job);
    assert.equal(stored.schemaVersion, 2); assert(stored.provider.equals(submitter.publicKey));
    assert.equal(Buffer.from(stored.termsHash).toString('hex'), release.termsHash);
    assert.equal(Buffer.from(stored.specHash).toString('hex'), specHash);
    assert.equal(Buffer.from(stored.inputHash).toString('hex'), inputHash);
    assert.equal(Buffer.from(stored.resultHash).toString('hex'), '00'.repeat(32));
    await rejected(() => fund(release));
  });
  await t.test('approval before submission, unauthorized provider, empty submission and early refund reject', async () => {
    await rejected(() => approve(release), /NotSubmitted/);
    await rejected(() => submit(release, attacker), /UnauthorizedProvider/);
    await rejected(() => submit(release, buyer), /UnauthorizedProvider/);
    await rejected(() => submit(release, submitter, '00'.repeat(32)), /EmptyCommitment/);
    await rejected(() => refund(release), /RefundTooEarly/);
  });
  signatures.submit = await submit(release);
  await t.test('submission freezes the result and cannot grant buyer/merchant payment privileges', async () => {
    assert.equal(await state(release), 'submitted');
    assert.equal(Buffer.from((await accounts.jobV2.fetch(addresses(release.id).job)).resultHash).toString('hex'), resultHash);
    await rejected(() => submit(release), /AlreadySubmitted/);
    await rejected(() => submit(release, submitter, inputHash), /AlreadySubmitted/);
    await rejected(() => approve(release, buyer, inputHash), /ResultMismatch/);
    await rejected(() => approve(release, attacker), /UnauthorizedBuyer/);
    await rejected(() => approve(release, submitter), /UnauthorizedBuyer/);
    await rejected(() => approve(release, buyer, resultHash, { mint: wrongMint, merchantToken: wrongMerchantToken }), /WrongMint/);
    await rejected(() => approve(release, buyer, resultHash, { merchantToken: attackerToken }), /WrongDestination/);
    await rejected(() => approve(release, buyer, resultHash, { merchantToken: nonAtaMerchant }), /WrongDestination/);
    await rejected(() => approve(release, buyer, resultHash, { vault: buyerToken }));
    await rejected(() => refund(release), /RefundTooEarly/);
  });
  await transferChecked(connection, payer, buyerToken, mint, addresses(release.id).vault, buyer, 17n, 6);
  const beforeRelease = await balances(release);
  signatures.approve = await approve(release);
  await t.test('exact approval pays recorded merchant only; surplus and terminal record remain', async () => {
    const after = await balances(release);
    assert.equal(after.buyer, beforeRelease.buyer); assert.equal(after.merchant - beforeRelease.merchant, AMOUNT);
    assert.equal(beforeRelease.vault - after.vault, AMOUNT); assert.equal(after.vault, 17n);
    assert.equal(await state(release), 'released');
    await rejected(() => approve(release), /NotFunded/);
    await rejected(() => refund(release), /NotFunded/);
    await rejected(() => submit(release), /AlreadySubmitted/);
    await rejected(() => fund(release));
  });

  const pendingRefund = await quote(local ? 20 : 60, local ? 15 : 45), submittedRefund = await quote(local ? 20 : 60, local ? 15 : 45);
  signatures.fundRefund = await fund(pendingRefund);
  signatures.fundSubmittedRefund = await fund(submittedRefund);
  signatures.submitRefund = await submit(submittedRefund);
  await t.test('both pending states reject early refund and wrong original buyer', async () => {
    await rejected(() => refund(pendingRefund), /RefundTooEarly/);
    await rejected(() => refund(submittedRefund), /RefundTooEarly/);
    await rejected(() => refund(pendingRefund, attacker), /UnauthorizedBuyer/);
    await rejected(() => refund(submittedRefund, attacker), /UnauthorizedBuyer/);
  });
  const deadline = Math.max(pendingRefund.expiresAt, submittedRefund.expiresAt);
  while (await now() < deadline) await delay(250);
  await t.test('expiry prevents late provider submission and late buyer approval', async () => {
    await rejected(() => submit(pendingRefund), /ApprovalExpired/);
    await rejected(() => approve(submittedRefund), /ApprovalExpired/);
    await rejected(() => refund(pendingRefund, buyer, { buyerToken: attackerToken }));
    await rejected(() => refund(submittedRefund, buyer, { buyerToken: nonAtaBuyer }), /WrongDestination/);
    await rejected(() => refund(submittedRefund, buyer, { mint: wrongMint, buyerToken: wrongBuyerToken }), /WrongMint/);
  });
  for (const value of [pendingRefund, submittedRefund]) {
    const originalState = await state(value), before = await balances(value);
    signatures[`${originalState}Refund`] = await refund(value);
    await t.test(`${originalState} refund returns exact payment and is terminal`, async () => {
      const after = await balances(value);
      assert.equal(after.buyer - before.buyer, AMOUNT); assert.equal(after.merchant, before.merchant);
      assert.equal(before.vault - after.vault, AMOUNT); assert.equal(await state(value), 'refunded');
      await rejected(() => refund(value), /NotFunded/);
      await rejected(() => approve(value), /NotFunded/);
      await rejected(() => submit(value), /AlreadySubmitted/);
      await rejected(() => fund(value));
    });
  }
  t.diagnostic(JSON.stringify({ version: 2, program: program.programId.toBase58(), mint: mint.toBase58(),
    isolatedBuyer: buyer.publicKey.toBase58(), isolatedMerchant: merchant.publicKey.toBase58(),
    isolatedProvider: submitter.publicKey.toBase58(), release: addresses(release.id).job.toBase58(),
    fundedRefund: addresses(pendingRefund.id).job.toBase58(), submittedRefund: addresses(submittedRefund.id).job.toBase58(), signatures }));
});
