import { useCallback, useEffect, useState } from 'react';
import { confirmTransaction, type Connection, type Transaction } from '@holdfast/chain';
import type { InjectedWallet } from './types';

function injected(): InjectedWallet | null { return window.phantom?.solana || window.solana || null; }

export function useWallet() {
  const [provider, setProvider] = useState<InjectedWallet | null>(injected);
  const [address, setAddress] = useState<string | null>(() => injected()?.publicKey?.toString() || null);
  const [connecting, setConnecting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const find = () => setProvider(injected());
    window.addEventListener('load', find);
    window.addEventListener('phantom#initialized', find);
    const timeout = window.setTimeout(find, 500);
    return () => {
      window.removeEventListener('load', find);
      window.removeEventListener('phantom#initialized', find);
      window.clearTimeout(timeout);
    };
  }, []);

  useEffect(() => {
    if (!provider) return;
    let live = true;
    const changed = () => { if (live) setAddress(provider.publicKey?.toString() || null); };
    provider.on?.('accountChanged', changed);
    provider.on?.('disconnect', changed);
    provider.connect({ onlyIfTrusted: true }).then(changed).catch(() => {});
    return () => { live = false; provider.removeListener?.('accountChanged', changed); provider.removeListener?.('disconnect', changed); };
  }, [provider]);

  const connect = useCallback(async () => {
    setError(null);
    const found = provider || injected();
    if (!found) { setError('Install a Phantom-compatible browser wallet, then reload this page.'); return; }
    setConnecting(true);
    try { const result = await found.connect(); setProvider(found); setAddress(result.publicKey.toString()); }
    catch (reason) { setError(reason instanceof Error ? reason.message : String(reason)); }
    finally { setConnecting(false); }
  }, [provider]);

  const disconnect = useCallback(async () => {
    try { await provider?.disconnect(); setAddress(null); } catch { setAddress(null); }
  }, [provider]);

  return { provider, address, connecting, error, connect, disconnect };
}

export async function sendTransaction(
  connection: Connection,
  provider: InjectedWallet | null,
  buyer: string,
  transaction: Transaction,
  broadcast: (signature: string) => void,
): Promise<string> {
  if (!provider || provider.publicKey?.toString() !== buyer) throw new Error('Connect the buyer wallet shown on this order.');
  let signature: string;
  if (provider.signTransaction) {
    const signed = await provider.signTransaction(transaction);
    signature = await connection.sendRawTransaction(signed.serialize(), { skipPreflight: false, preflightCommitment: 'confirmed' });
  } else if (provider.signAndSendTransaction) {
    signature = (await provider.signAndSendTransaction(transaction)).signature;
  } else { throw new Error('This wallet cannot sign Solana transactions. Use a Phantom-compatible wallet.'); }
  broadcast(signature);
  try { await confirmTransaction(connection, signature); }
  catch (error) { throw new Error(`Transaction ${signature} was broadcast but finalization was not confirmed. Check the transaction link and refresh chain state before retrying. ${error instanceof Error ? error.message : ''}`); }
  return signature;
}
