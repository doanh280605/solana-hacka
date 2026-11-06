import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { PublicKey, fetchChainTime, fetchJob, getConnection, type Connection, type Job, type PublicConfig } from '@holdfast/chain';

const tokenProgram = new PublicKey('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA');
const associatedProgram = new PublicKey('ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL');

function associatedAddress(owner: string, mint: string): PublicKey {
  return PublicKey.findProgramAddressSync([new PublicKey(owner).toBytes(), tokenProgram.toBytes(), new PublicKey(mint).toBytes()], associatedProgram)[0];
}

async function tokenBalance(connection: Connection, address: PublicKey): Promise<string> {
  const account = await connection.getAccountInfo(address, 'finalized');
  if (!account) return '0';
  return (await connection.getTokenAccountBalance(address, 'finalized')).value.amount;
}

export type Balances = { buyer: string | null; merchant: string | null; vault: string | null };

export function useLedger(config: PublicConfig | null, address: string | null, buyer: string | null) {
  const initialized = useMemo(() => {
    try { return { connection: config ? getConnection(config) : null, error: null }; }
    catch (reason) { return { connection: null, error: reason instanceof Error ? reason.message : String(reason) }; }
  }, [config]);
  const connection = initialized.connection;
  const [job, setJob] = useState<Job | null>(null);
  const [chainTime, setChainTime] = useState<number | null>(null);
  const [balances, setBalances] = useState<Balances>({ buyer: null, merchant: null, vault: null });
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const epoch = useRef(0);
  const refreshing = useRef(false);

  const refresh = useCallback(async () => {
    if (!connection || !config || refreshing.current) return;
    const generation = epoch.current;
    refreshing.current = true;
    setLoading(true);
    try {
      const [now, currentJob] = await Promise.all([
        fetchChainTime(connection), address ? fetchJob(connection, config, address) : Promise.resolve(null),
      ]);
      const owner = currentJob?.buyer || buyer;
      const merchant = currentJob?.merchant || config.merchant;
      const mint = currentJob?.mint || config.mint;
      const [buyerBalance, merchantBalance, vaultBalance] = await Promise.all([
        owner ? tokenBalance(connection, associatedAddress(owner, mint)) : Promise.resolve(null),
        tokenBalance(connection, associatedAddress(merchant, mint)),
        currentJob ? tokenBalance(connection, new PublicKey(currentJob.vault)) : Promise.resolve('0'),
      ]);
      if (generation !== epoch.current) return;
      setChainTime(now); setJob(currentJob); setBalances({ buyer: buyerBalance, merchant: merchantBalance, vault: vaultBalance }); setError(null);
    } catch (reason) { if (generation === epoch.current) setError(reason instanceof Error ? reason.message : String(reason)); }
    finally { refreshing.current = false; if (generation === epoch.current) setLoading(false); }
  }, [connection, config, address, buyer]);

  useEffect(() => {
    epoch.current += 1;
    refreshing.current = false;
    setJob(null); setChainTime(null); setBalances({ buyer: null, merchant: null, vault: null });
    void refresh();
    const interval = window.setInterval(() => void refresh(), 3000);
    return () => { epoch.current += 1; window.clearInterval(interval); };
  }, [refresh]);

  return { connection, job, chainTime, balances, error: initialized.error || error, loading, refresh };
}

export function short(address: string | null | undefined): string { return address ? `${address.slice(0, 5)}…${address.slice(-5)}` : 'Not connected'; }

export function formatTokens(amount: string | null): string {
  if (amount === null) return '—';
  try {
    const value = BigInt(amount);
    const whole = value / 1_000_000n;
    const fraction = (value % 1_000_000n).toString().padStart(6, '0').replace(/0+$/, '');
    return `${whole.toLocaleString()}${fraction ? `.${fraction}` : '.00'}`;
  } catch { return '—'; }
}

export function timeRemaining(expiresAt: number | undefined, now: number | null): string {
  if (!expiresAt || now === null) return 'Reading chain clock';
  const seconds = Math.max(0, expiresAt - now);
  if (!seconds) return 'Deadline reached';
  return `${Math.floor(seconds / 60).toString().padStart(2, '0')}:${(seconds % 60).toString().padStart(2, '0')}`;
}
