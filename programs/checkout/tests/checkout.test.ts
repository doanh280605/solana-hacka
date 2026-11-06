import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import test from "node:test";
import { AnchorProvider, Program, Wallet, type Idl } from "@coral-xyz/anchor";
import BN from "bn.js";
import {
  AccountLayout,
  createAccount,
  createMint,
  createTransferCheckedInstruction,
  getAccount,
  getOrCreateAssociatedTokenAccount,
  mintTo,
  TOKEN_PROGRAM_ID,
} from "@solana/spl-token";
import {
  Connection,
  Keypair,
  PublicKey,
  SystemProgram,
  Transaction,
} from "@solana/web3.js";

// These are live program tests, never mocked account fixtures. Deploy first.
// The deployment wallet must also control the configured mock mint authority.
const AMOUNT = 5_000_000n;
const LOADER = new PublicKey("BPFLoaderUpgradeab1e11111111111111111111111");

async function keypair(path: string): Promise<Keypair> {
  return Keypair.fromSecretKey(
    Uint8Array.from(JSON.parse(await readFile(resolve(path), "utf8"))),
  );
}

test("live checkout: balances, binding, replay protection, consent and expiry", { timeout: 240_000 }, async (t) => {
  const url = process.env.ANCHOR_PROVIDER_URL ?? "http://127.0.0.1:8899";
  assert(
    /localhost|127\.0\.0\.1/.test(new URL(url).hostname) ||
      process.env.CHECKOUT_TEST_ALLOW_DEVNET === "1",
    "Set CHECKOUT_TEST_ALLOW_DEVNET=1 explicitly to run against Devnet",
  );
  const payer = await keypair(process.env.ANCHOR_WALLET ?? ".local/keys/deployer.json");
  const mintSigner = await keypair(process.env.CHECKOUT_MINT_KEYPAIR ?? ".local/keys/mint.json");
  const connection = new Connection(url, "confirmed");
  // Never send this disposable-token suite to mainnet through a custom RPC.
  if (!/localhost|127\.0\.0\.1/.test(new URL(url).hostname)) {
    assert.equal(await connection.getGenesisHash(), "EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG");
  }
  const provider = new AnchorProvider(connection, new Wallet(payer), {
    commitment: "confirmed",
    preflightCommitment: "confirmed",
  });
  const idl = JSON.parse(
    await readFile(resolve(process.env.CHECKOUT_IDL ?? "target/idl/checkout.json"), "utf8"),
  ) as Idl;
  const program = new Program(idl, provider);
  const programId = program.programId;
  const deployed = await connection.getAccountInfo(programId);
  assert(deployed?.executable, "checkout must be deployed, executable and built from this source");
  assert(deployed.owner.equals(LOADER), "initializer requires an upgradeable deployment");
  const mint = mintSigner.publicKey;
  const buyer = Keypair.generate();
  const merchant = Keypair.generate();
  const attacker = Keypair.generate();
  const [config] = PublicKey.findProgramAddressSync([Buffer.from("config")], programId);
  const [programData] = PublicKey.findProgramAddressSync([programId.toBuffer()], LOADER);
  const accounts = program.account as any;
  const signatures: Record<string, string> = {};

  await provider.sendAndConfirm(
    new Transaction().add(
      SystemProgram.transfer({ fromPubkey: payer.publicKey, toPubkey: buyer.publicKey, lamports: 30_000_000 }),
      SystemProgram.transfer({ fromPubkey: payer.publicKey, toPubkey: attacker.publicKey, lamports: 10_000_000 }),
    ),
  );
  if (!(await connection.getAccountInfo(mint))) {
    await createMint(connection, payer, payer.publicKey, null, 6, mintSigner);
  }
  const wrongMint = await createMint(connection, payer, payer.publicKey, null, 6);
  const wrongDecimalsMint = await createMint(connection, payer, payer.publicKey, null, 9);
  const buyerToken = (await getOrCreateAssociatedTokenAccount(connection, payer, mint, buyer.publicKey)).address;
  const merchantToken = (await getOrCreateAssociatedTokenAccount(connection, payer, mint, merchant.publicKey)).address;
  const attackerToken = (await getOrCreateAssociatedTokenAccount(connection, payer, mint, attacker.publicKey)).address;
  const wrongBuyerToken = (await getOrCreateAssociatedTokenAccount(connection, payer, wrongMint, buyer.publicKey)).address;
  const wrongMerchantToken = (await getOrCreateAssociatedTokenAccount(connection, payer, wrongMint, merchant.publicKey)).address;
  const nonAtaBuyer = await createAccount(connection, payer, mint, buyer.publicKey, Keypair.generate());
  const nonAtaMerchant = await createAccount(connection, payer, mint, merchant.publicKey, Keypair.generate());
  await mintTo(connection, payer, mint, buyerToken, payer, 100_000_000n);
  await mintTo(connection, payer, wrongMint, wrongBuyerToken, payer, 100_000_000n);

  async function now(): Promise<number> {
    for (let attempt = 0; attempt < 20; attempt++) {
      const timestamp = await connection.getBlockTime(await connection.getSlot("confirmed"));
      if (timestamp !== null) return timestamp;
      await delay(250);
    }
    throw new Error("RPC has not supplied chain time");
  }

  function addresses(id: Buffer) {
    const [job] = PublicKey.findProgramAddressSync([Buffer.from("job"), buyer.publicKey.toBuffer(), id], programId);
    const [vault] = PublicKey.findProgramAddressSync([Buffer.from("vault"), job.toBuffer()], programId);
    return { job, vault };
  }

  function fund(id: Buffer, expiresAt: number, overrides: Record<string, PublicKey> = {}, amount = AMOUNT) {
    return program.methods.fund!(Array.from(id), new BN(amount.toString()), new BN(expiresAt))
      .accountsStrict({
        buyer: buyer.publicKey,
        merchant: merchant.publicKey,
        config,
        mint,
        buyerToken,
        merchantToken,
        ...addresses(id),
        tokenProgram: TOKEN_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
        ...overrides,
      })
      .signers([buyer])
      .rpc();
  }

  function approve(id: Buffer, signer = buyer, overrides: Record<string, PublicKey> = {}) {
    return program.methods.approve!()
      .accountsStrict({
        buyer: signer.publicKey,
        ...addresses(id),
        mint,
        merchantToken,
        tokenProgram: TOKEN_PROGRAM_ID,
        ...overrides,
      })
      .signers([signer])
      .rpc();
  }

  function refund(id: Buffer, signer = buyer, overrides: Record<string, PublicKey> = {}) {
    return program.methods.refund!()
      .accountsStrict({
        buyer: signer.publicKey,
        ...addresses(id),
        mint,
        buyerToken,
        tokenProgram: TOKEN_PROGRAM_ID,
        ...overrides,
      })
      .signers([signer])
      .rpc();
  }

  async function snapshot(extra: PublicKey[] = []) {
    const keys = [config, mint, wrongMint, buyerToken, merchantToken, attackerToken, wrongBuyerToken, wrongMerchantToken, nonAtaBuyer, nonAtaMerchant, ...extra];
    const infos = await connection.getMultipleAccountsInfo(keys, "confirmed");
    // Compare full job/config/token data and amounts. Exclude SOL lamports:
    // rejected submitted transactions may still charge their network fee.
    return Object.fromEntries(keys.map((key, index) => {
      const info = infos[index];
      return [key.toBase58(), info === null ? null : {
        owner: info.owner.toBase58(),
        data: info.data.toString("base64"),
        amount: info.owner.equals(TOKEN_PROGRAM_ID) && info.data.length === AccountLayout.span
          ? AccountLayout.decode(info.data).amount.toString()
          : undefined,
      }];
    }));
  }

  async function rejected(action: () => Promise<unknown>, extra: PublicKey[] = [], expected?: RegExp) {
    const before = await snapshot(extra);
    await assert.rejects(action, (error: unknown) => {
      const text = String(error);
      assert.match(text, expected ?? /AnchorError|custom program error|already in use|Error processing Instruction|signature verification/i);
      return true;
    });
    assert.deepEqual(await snapshot(extra), before, "rejection must preserve every job field and token balance");
  }

  async function balances(id: Buffer) {
    const { vault } = addresses(id);
    const [buyerAccount, merchantAccount, vaultAccount] = await Promise.all([
      getAccount(connection, buyerToken),
      getAccount(connection, merchantToken),
      getAccount(connection, vault),
    ]);
    return { buyer: buyerAccount.amount, merchant: merchantAccount.amount, vault: vaultAccount.amount };
  }

  async function state(id: Buffer) {
    const value = await accounts.job.fetch(addresses(id).job);
    return Object.keys(value.state)[0];
  }

  const initializeAccounts = {
    authority: payer.publicKey, mint, config, program: programId, programData, systemProgram: SystemProgram.programId,
  };
  if (!(await connection.getAccountInfo(config))) {
    await t.test("initializer cannot be front-run by a signer who is not the upgrade authority", async () => {
      await rejected(() => program.methods.initialize!()
        .accountsStrict({ ...initializeAccounts, authority: attacker.publicKey })
        .signers([attacker]).rpc(), [], /UnauthorizedInitializer/);
      assert.equal(await connection.getAccountInfo(config), null);
    });
    await t.test("initializer rejects wrong decimals", async () => {
      await rejected(() => program.methods.initialize!()
        .accountsStrict({ ...initializeAccounts, mint: wrongDecimalsMint }).rpc(), [], /InvalidMintDecimals/);
    });
    await t.test("initializer rejects substituted ProgramData", async () => {
      await rejected(() => program.methods.initialize!()
        .accountsStrict({ ...initializeAccounts, programData: config }).rpc());
    });
    signatures.initialize = await program.methods.initialize!().accountsStrict(initializeAccounts).rpc();
  } else {
    t.diagnostic("Config already existed: fresh-initializer authorization tests require a fresh deployment and were not rerun.");
  }
  assert((await accounts.config.fetch(config)).mint.equals(mint), "test mint must match immutable config");
  await t.test("configuration cannot be initialized twice or switched to another mint", async () => {
    await rejected(() => program.methods.initialize!()
      .accountsStrict({ ...initializeAccounts, mint: wrongMint }).rpc());
  });

  const releaseId = randomBytes(32);
  const releaseAddresses = Object.values(addresses(releaseId));
  const releaseDeadline = await now() + 300;
  await t.test("fund rejects zero amount, expired deadline and deadline beyond 24h atomically", async () => {
    await rejected(() => fund(releaseId, releaseDeadline, {}, 0n), releaseAddresses, /InvalidAmount/);
    await rejected(() => fund(releaseId, 0), releaseAddresses, /InvalidDeadline/);
    await rejected(() => fund(releaseId, releaseDeadline + 86_400), releaseAddresses, /InvalidDeadline/);
  });
  await t.test("a failed token CPI rolls back the new job and vault as well as balances", async () => {
    await rejected(() => fund(releaseId, releaseDeadline, {}, 1_000_000_000n), releaseAddresses);
    assert.equal(await connection.getAccountInfo(addresses(releaseId).job), null);
    assert.equal(await connection.getAccountInfo(addresses(releaseId).vault), null);
  });
  await t.test("fund rejects wrong mint, wrong token program and correct-owner non-ATA destinations", async () => {
    await rejected(() => fund(releaseId, releaseDeadline, { mint: wrongMint, buyerToken: wrongBuyerToken, merchantToken: wrongMerchantToken }), releaseAddresses, /WrongMint/);
    await rejected(() => fund(releaseId, releaseDeadline, { tokenProgram: SystemProgram.programId }), releaseAddresses);
    await rejected(() => fund(releaseId, releaseDeadline, { buyerToken: nonAtaBuyer }), releaseAddresses, /WrongDestination/);
    await rejected(() => fund(releaseId, releaseDeadline, { merchantToken: nonAtaMerchant }), releaseAddresses, /WrongDestination/);
  });
  await t.test("fund atomically records the quote and escrows exactly five mock USDC", async () => {
    const beforeBuyer = (await getAccount(connection, buyerToken)).amount;
    const beforeMerchant = (await getAccount(connection, merchantToken)).amount;
    signatures.fundRelease = await fund(releaseId, releaseDeadline);
    assert.deepEqual(await balances(releaseId), { buyer: beforeBuyer - AMOUNT, merchant: beforeMerchant, vault: AMOUNT });
    const job = await accounts.job.fetch(addresses(releaseId).job);
    assert(job.buyer.equals(buyer.publicKey));
    assert(job.merchant.equals(merchant.publicKey));
    assert(job.mint.equals(mint));
    assert.equal(Buffer.from(job.jobId).toString("hex"), releaseId.toString("hex"));
    assert.equal(job.amount.toString(), AMOUNT.toString());
    assert.equal(job.expiresAt.toNumber(), releaseDeadline);
    assert.equal(await state(releaseId), "funded");
    const vault = await getAccount(connection, addresses(releaseId).vault);
    assert(vault.owner.equals(addresses(releaseId).job));
    assert.equal(vault.delegate, null);
    assert.equal(vault.closeAuthority, null);
    t.diagnostic(JSON.stringify({ stage: "funded", job: addresses(releaseId).job.toBase58(), balances: await balances(releaseId) }, bigintJson));
  });
  await t.test("funded job rejects duplicate funding, wrong signer, early refund, wrong mint and wrong merchant", async () => {
    await rejected(() => fund(releaseId, releaseDeadline), releaseAddresses);
    await rejected(() => approve(releaseId, attacker), releaseAddresses, /UnauthorizedBuyer/);
    await rejected(() => refund(releaseId, attacker), releaseAddresses, /UnauthorizedBuyer/);
    await rejected(() => refund(releaseId), releaseAddresses, /RefundTooEarly/);
    await rejected(() => approve(releaseId, buyer, { mint: wrongMint, merchantToken: wrongMerchantToken }), releaseAddresses, /WrongMint/);
    await rejected(() => approve(releaseId, buyer, { merchantToken: attackerToken }), releaseAddresses, /WrongDestination/);
    await rejected(() => approve(releaseId, buyer, { merchantToken: nonAtaMerchant }), releaseAddresses, /WrongDestination/);
  });
  await t.test("vault address cannot be substituted and another wallet cannot move vault tokens", async () => {
    const fakeVault = await createAccount(connection, payer, mint, addresses(releaseId).job, Keypair.generate());
    await rejected(() => approve(releaseId, buyer, { vault: fakeVault }), [...releaseAddresses, fakeVault]);
    await rejected(() => provider.sendAndConfirm(new Transaction().add(createTransferCheckedInstruction(
      addresses(releaseId).vault, mint, attackerToken, attacker.publicKey, AMOUNT, 6,
    )), [attacker]), releaseAddresses);
  });
  await t.test("approval releases exactly the recorded amount, retaining any unsolicited surplus", async () => {
    await provider.sendAndConfirm(new Transaction().add(createTransferCheckedInstruction(
      buyerToken, mint, addresses(releaseId).vault, buyer.publicKey, 7n, 6,
    )), [buyer]);
    const before = await balances(releaseId);
    signatures.approve = await approve(releaseId);
    assert.equal(await state(releaseId), "released");
    assert.deepEqual(await balances(releaseId), { buyer: before.buyer, merchant: before.merchant + AMOUNT, vault: 7n });
    t.diagnostic(JSON.stringify({ stage: "released", job: addresses(releaseId).job.toBase58(), balances: await balances(releaseId) }, bigintJson));
  });
  await t.test("released record survives and prevents repeat approval, competing refund and funding replay", async () => {
    await rejected(() => approve(releaseId), releaseAddresses, /NotFunded/);
    await rejected(() => refund(releaseId), releaseAddresses, /NotFunded/);
    await rejected(() => fund(releaseId, releaseDeadline), releaseAddresses);
    assert.equal(await state(releaseId), "released");
  });

  const refundId = randomBytes(32);
  const refundAddresses = Object.values(addresses(refundId));
  const refundDeadline = await now() + 20;
  const beforeRefundBuyer = (await getAccount(connection, buyerToken)).amount;
  signatures.fundRefund = await fund(refundId, refundDeadline);
  assert.equal((await balances(refundId)).buyer, beforeRefundBuyer - AMOUNT);
  await t.test("second funded job rejects early refund without changing balances or state", async () => {
    await rejected(() => refund(refundId), refundAddresses, /RefundTooEarly/);
  });
  await t.test("expired funded job rejects approval and refund to substituted buyer or token account", async () => {
    while (await now() < refundDeadline) await delay(500);
    await rejected(() => approve(refundId), refundAddresses, /ApprovalExpired/);
    await rejected(() => refund(refundId, attacker, { buyerToken: attackerToken }), refundAddresses, /UnauthorizedBuyer/);
    await rejected(() => refund(refundId, buyer, { buyerToken: attackerToken }), refundAddresses);
    await rejected(() => refund(refundId, buyer, { buyerToken: nonAtaBuyer }), refundAddresses, /WrongDestination/);
    await rejected(() => refund(refundId, buyer, { mint: wrongMint, buyerToken: wrongBuyerToken }), refundAddresses, /WrongMint/);
  });
  await t.test("buyer refunds exactly the deposit after chain deadline without any merchant service", async () => {
    const before = await balances(refundId);
    signatures.refund = await refund(refundId);
    assert.equal(await state(refundId), "refunded");
    assert.deepEqual(await balances(refundId), { buyer: before.buyer + AMOUNT, merchant: before.merchant, vault: 0n });
    assert.equal((await balances(refundId)).buyer, beforeRefundBuyer);
    t.diagnostic(JSON.stringify({ stage: "refunded", job: addresses(refundId).job.toBase58(), balances: await balances(refundId) }, bigintJson));
  });
  await t.test("refunded record prevents repeated refund, competing approval and reinitialization", async () => {
    await rejected(() => refund(refundId), refundAddresses, /NotFunded/);
    await rejected(() => approve(refundId), refundAddresses, /NotFunded/);
    await rejected(async () => fund(refundId, await now() + 60), refundAddresses);
    assert.equal(await state(refundId), "refunded");
  });
  t.diagnostic(JSON.stringify({ program: programId.toBase58(), mint: mint.toBase58(), signatures, note: "Token balances exclude SOL transaction fees and rent" }));
});

function bigintJson(_key: string, value: unknown) {
  return typeof value === "bigint" ? value.toString() : value;
}
