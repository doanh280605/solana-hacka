import { useCallback, useEffect, useRef, useState } from 'react';
import { ApiError, post, request, setCsrfToken } from './api';
import { errorMessage } from './config';
import { signInChallenge, signInErrorMessage } from './sign-in';
export { validateSignInMessage } from './sign-in';
import type { Session } from './types';
import type { useWallet } from './wallet';

type Wallet = ReturnType<typeof useWallet>;
export function encodeSignature(signature: Uint8Array): string { return btoa(String.fromCharCode(...signature)); }

// Only /app mounts this hook. Recovery never initializes authentication.
export function useSession(wallet: Wallet, cluster: string) {
  const [session, setSession] = useState<Session | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const generation = useRef(0);
  const current = useRef<Session | null>(null);

  useEffect(() => {
    const epoch = ++generation.current;
    const previous = current.current;
    current.current = null; setSession(null); setError(null); setCsrfToken(null); setBusy(true);
    let alive = true;
    const restore = async () => {
      if (previous) {
        setCsrfToken(previous.csrfToken);
        await post('/api/auth/logout', {}).catch(() => {});
        if (generation.current === epoch) setCsrfToken(null);
        if (!alive || generation.current !== epoch) return;
      }
      if (!wallet.address) return;
      try {
        const value = await request<Session>('/api/auth/session');
        if (!alive || generation.current !== epoch) return;
        if (value.wallet !== wallet.address || value.expiresAt * 1000 <= Date.now()) {
          setCsrfToken(value.csrfToken);
          await post('/api/auth/logout', {}).catch(() => {});
          setCsrfToken(null); return;
        }
        current.current = value; setSession(value); setCsrfToken(value.csrfToken);
      } catch (reason) { if (alive && !(reason instanceof ApiError && reason.status === 401)) setError(errorMessage(reason)); }
    };
    void restore().finally(() => { if (alive && generation.current === epoch) setBusy(false); });
    return () => { alive = false; };
  }, [wallet.address]);

  useEffect(() => {
    if (!session) return;
    const timeout = window.setTimeout(() => { current.current = null; setSession(null); setCsrfToken(null); setError('Your session expired. Sign in again; your deposit remains on Solana.'); }, Math.max(0, session.expiresAt * 1000 - Date.now()));
    return () => window.clearTimeout(timeout);
  }, [session]);

  const signIn = useCallback(async () => {
    if (!wallet.address || !wallet.provider || (typeof wallet.provider.signIn !== 'function' && typeof wallet.provider.signMessage !== 'function')) { setError('Connect a wallet with sign-in or message-signing support.'); return; }
    const epoch = generation.current;
    const address = wallet.address;
    setBusy(true); setError(null);
    try {
      const challenge = await post<{ nonce: string; message: string; expiresAt: number }>('/api/auth/nonce', { wallet: address });
      const signature = await signInChallenge(wallet.provider, challenge, address, cluster, { isCurrent: () => generation.current === epoch });
      if (wallet.provider.publicKey?.toString() !== address || generation.current !== epoch) throw new Error('Wallet changed. Sign in again.');
      const value = await post<Session>('/api/auth/verify', { wallet: address, nonce: challenge.nonce, signature: encodeSignature(signature) });
      if (generation.current !== epoch) return;
      if (value.wallet !== address || value.expiresAt * 1000 <= Date.now() || !value.csrfToken) throw new Error('Invalid session response.');
      current.current = value; setSession(value); setCsrfToken(value.csrfToken);
    } catch (reason) { if (generation.current === epoch) setError(signInErrorMessage(reason, cluster, errorMessage(reason))); }
    finally { if (generation.current === epoch) setBusy(false); }
  }, [wallet.address, wallet.provider, cluster]);

  const signOut = useCallback(async () => {
    ++generation.current;
    current.current = null; setSession(null); setBusy(true);
    try { await post('/api/auth/logout', {}); }
    catch (reason) { setError(errorMessage(reason)); }
    finally { current.current = null; setSession(null); setCsrfToken(null); setBusy(false); }
  }, []);

  const invalidate = useCallback(() => {
    current.current = null; setSession(null); setCsrfToken(null);
    setError('Your session is no longer valid. Sign in again to continue.');
  }, []);

  return { session, busy, error, signIn, signOut, invalidate };
}
