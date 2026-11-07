import { PublicKey, type Connection } from '@holdfast/chain';

const tokenProgram = new PublicKey('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA');
type TokenAccount = { owner: PublicKey; executable: boolean; data: Uint8Array };
export type BalanceTarget = { address: PublicKey; mint: string; authority: string };

export function decodeTokenBalance(account: TokenAccount | null, target: Pick<BalanceTarget, 'mint' | 'authority'>): string {
  if (!account) return '0';
  if (account.executable || !account.owner.equals(tokenProgram) || account.data.byteLength !== 165) throw new Error('Invalid legacy token account owner or layout.');
  const data = account.data;
  if (!new PublicKey(data.subarray(0, 32)).equals(new PublicKey(target.mint)) || !new PublicKey(data.subarray(32, 64)).equals(new PublicKey(target.authority)) || ![1, 2].includes(data[108])) throw new Error('Token account mint, authority or state differs from the payment receipt.');
  return new DataView(data.buffer, data.byteOffset, data.byteLength).getBigUint64(64, true).toString();
}

export async function fetchTokenBalances(connection: Pick<Connection, 'getMultipleAccountsInfo'>, targets: BalanceTarget[]): Promise<string[]> {
  if (!targets.length) return [];
  const accounts = await connection.getMultipleAccountsInfo(targets.map((target) => target.address), 'finalized');
  if (accounts.length !== targets.length) throw new Error('The finalized token balance response is incomplete.');
  return accounts.map((account, index) => decodeTokenBalance(account, targets[index]!));
}
