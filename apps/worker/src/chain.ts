import { PublicKey, deriveJobAddress, deriveVaultAddress, fetchChainTime, fetchJob, getConnection, type PublicConfig } from '@holdfast/chain';
import type { ChainGateway, VaultSnapshot } from './types.js';
import { TOKEN_PROGRAM } from './types.js';

export function createChainGateway(config: PublicConfig): ChainGateway {
  const connection = getConnection(config);
  return {
    config,
    validateAddress(address) {
      try { return new PublicKey(address).toBase58() === address; }
      catch { return false; }
    },
    deriveJob(buyer, jobId) { return deriveJobAddress(config, buyer, jobId).toBase58(); },
    deriveVault(jobAddress) { return deriveVaultAddress(config, jobAddress).toBase58(); },
    publicKeyBytes(address) { return new PublicKey(address).toBytes(); },
    getTime() { return fetchChainTime(connection); },
    readJob(address) { return fetchJob(connection, config, address); },
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
