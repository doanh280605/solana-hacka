import { readFileSync } from 'node:fs';
import { PublicKey, Keypair, Transaction, transactionSignature, buildSubmitV2Transaction, confirmTransaction, deriveJobAddress, deriveJobV2Address, deriveVaultAddress, fetchChainTime, fetchJob, getConnection, type PublicConfig } from '@holdfast/chain';
import { HttpError } from './errors.js';
import type { ChainGateway, VaultSnapshot } from './types.js';
import { TOKEN_PROGRAM } from './types.js';

export function createChainGateway(config: PublicConfig, options: { providerKeypairPath?: string } = {}): ChainGateway {
  const connection = getConnection(config);
  let provider: Keypair | undefined;
  if (options.providerKeypairPath) {
    const raw: unknown = JSON.parse(readFileSync(options.providerKeypairPath, 'utf8'));
    if (!Array.isArray(raw) || raw.length !== 64 || raw.some(v => !Number.isInteger(v) || v < 0 || v > 255)) throw new Error('PROVIDER_KEYPAIR_PATH must contain a Solana keypair');
    provider = Keypair.fromSecretKey(Uint8Array.from(raw));
    if (provider.publicKey.toBase58() !== config.provider) throw new Error('Provider signer does not match configured PROVIDER');
    if (config.provider === config.merchant) throw new Error('Use a dedicated provider signer distinct from the merchant wallet');
  }
  return {
    config,
    validateAddress(address) {
      try { return new PublicKey(address).toBase58() === address; }
      catch { return false; }
    },
    deriveJob(buyer, jobId) { return deriveJobAddress(config, buyer, jobId).toBase58(); },
    deriveJobV2(buyer, jobId) { return deriveJobV2Address(config, buyer, jobId).toBase58(); },
    deriveVault(jobAddress) { return deriveVaultAddress(config, jobAddress).toBase58(); },
    publicKeyBytes(address) { return new PublicKey(address).toBytes(); },
    getTime() { return fetchChainTime(connection); },
    readJob(address) { return fetchJob(connection, config, address); },
    ...(provider ? {
      async validateProviderSigner(): Promise<void> {
        const program = await connection.getAccountInfo(new PublicKey(config.programId), 'finalized');
        if (!program?.executable) throw new Error('Configured program is not deployed and executable');
        if (program.owner.toBase58() === 'BPFLoaderUpgradeab1e11111111111111111111111' && program.data.length >= 36 && program.data.readUInt32LE(0) === 2) {
          const programData = await connection.getAccountInfo(new PublicKey(program.data.subarray(4, 36)), 'finalized');
          if (!programData || programData.data.length < 13 || programData.data.readUInt32LE(0) !== 3) throw new Error('Cannot verify program upgrade authority');
          if (programData.data[12] === 1) {
            if (programData.data.length < 45) throw new Error('Cannot verify program upgrade authority');
            if (new PublicKey(programData.data.subarray(13, 45)).equals(provider!.publicKey)) throw new Error('The application provider signer must not be the program upgrade-authority key');
          }
        }
      },
      async submitResult(jobAddress: string, resultHash: string, persistSigned: (transaction: string, signature: string) => Promise<void>, signedTransaction?: string): Promise<string> {
        const transaction = signedTransaction ? Transaction.from(Buffer.from(signedTransaction, 'base64'))
          : await buildSubmitV2Transaction(connection, config, { provider: provider!.publicKey, jobAddress, resultHash });
        if (!signedTransaction) transaction.sign(provider!);
        if (!transaction.feePayer?.equals(provider!.publicKey) || !transaction.verifySignatures() || !transaction.signature) throw new HttpError(503, 'Provider submission signature is invalid');
        const bytes = transaction.serialize();
        const signature = transactionSignature(transaction);
        if (!signedTransaction) await persistSigned(bytes.toString('base64'), signature);
        try {
          // The exact signed bytes are durable before send. Retried requests never build a new transaction.
          const sent = await connection.sendRawTransaction(bytes, { skipPreflight: false, maxRetries: 0 });
          if (sent !== signature) throw new Error('RPC returned a different submission signature');
          await confirmTransaction(connection, signature);
        } catch {
          const latest = await fetchJob(connection, config, jobAddress).catch(() => null);
          if (!latest || !['Submitted', 'Released'].includes(latest.state) || latest.resultHash !== resultHash) throw new HttpError(503, 'Provider submission is not finalized; refresh to reconcile the same signed transaction');
        }
        return signature;
      },
    } : {}),
    async readVault(address): Promise<VaultSnapshot | null> {
      const info = await connection.getAccountInfo(new PublicKey(address), 'finalized');
      if (!info) return null;
      // SPL Token's legacy Account layout: mint[32], authority[32], amount u64,
      // delegate COption[36], state u8. Token-2022/extension accounts are refused.
      if (info.owner.toBase58() !== TOKEN_PROGRAM || info.data.length !== 165) {
        return { address, programOwner: info.owner.toBase58(), mint: '', authority: '', amount: '0', initialized: false };
      }
      return {
        address,
        programOwner: info.owner.toBase58(),
        mint: new PublicKey(info.data.subarray(0, 32)).toBase58(),
        authority: new PublicKey(info.data.subarray(32, 64)).toBase58(),
        amount: info.data.readBigUInt64LE(64).toString(),
        initialized: info.data[108] === 1,
      };
    },
  };
}
