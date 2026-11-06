import {
  PublicKey, Transaction, type PublicConfig,
  buildFundTransaction, buildApproveTransaction, buildRefundTransaction,
  confirmTransaction, deriveJobAddress, explorerUrl, getConnection, validateConfig,
} from '../src/index.js';

export interface ConnectedWallet {
  publicKey: PublicKey;
  signTransaction(transaction: Transaction): Promise<Transaction>;
}

// Call each method from a separate buyer action. Importing this module sends nothing.
export function checkoutClient(config: PublicConfig, wallet: ConnectedWallet) {
  const settings = validateConfig({ ...config });
  const connection = getConnection(settings);
  const buyer = wallet.publicKey;

  async function submit(transaction: Transaction) {
    if (!wallet.publicKey.equals(buyer)) throw new Error('Reconnect the original buyer wallet.');
    const signed = await wallet.signTransaction(transaction);
    const signature = await connection.sendRawTransaction(signed.serialize(), { preflightCommitment: 'confirmed' });
    const submitted = { signature, explorer: explorerUrl(settings, signature) };
    try { await confirmTransaction(connection, signature); }
    catch (cause) {
      throw Object.assign(new Error(`Confirmation unavailable; inspect transaction ${signature} before retrying.`, { cause }), submitted);
    }
    return submitted;
  }

  return {
    prepareFunding(quote: { jobId: string; expiresAt: number }) {
      const { jobId, expiresAt } = quote;
      const jobAddress = deriveJobAddress(settings, buyer, jobId).toBase58();
      return {
        jobAddress, recoveryPath: `/recover?job=${jobAddress}`,
        fund: async () => submit(await buildFundTransaction(connection, settings, { buyer, jobId, expiresAt })),
      };
    },
    async approve(jobAddress: string) {
      return submit(await buildApproveTransaction(connection, settings, { buyer, jobAddress }));
    },
    async refund(jobAddress: string) {
      return submit(await buildRefundTransaction(connection, settings, { buyer, jobAddress }));
    },
  };
}
