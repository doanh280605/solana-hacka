import { useCallback, useEffect, useRef, useState } from 'react';
import { ApiError, post, request, setCsrfToken } from './api';
import { errorMessage } from './config';
import type { Session } from './types';
import type { useWallet } from './wallet';

type Wallet = ReturnType<typeof useWallet>;
export function encodeSignature(signature: Uint8Array): string { return btoa(String.fromCharCode(...signature)); }

export function validateSignInMessage(message: string, wallet: string, nonce: string, expiresAt: number, cluster: string): void {
  const lines = message.split('\n');
  const expected = [
    `${window.location.host} wants you to sign in with your Solana account:`, wallet, '',
    'Sign in to osid (no payment authorization)', '', `URI: ${window.location.origin}/app`,
    'Version: 1', `Chain ID: ${cluster}`, `Nonce: ${nonce}`,
  ];
  if (lines.length !== 11 || expected.some((line, index) => lines[index] !== line)) throw new Error('The sign-in request does not match this site, wallet or purpose.');
  const issuedAt = Date.parse(lines[9].replace(/^Issued At: /, ''));
  const expiration = Date.parse(lines[10].replace(/^Expiration Time: /, ''));
  const now = Date.now();
  if (!lines[9].startsWith('Issued At: ') || !lines[10].startsWith('Expiration Time: ') || !Number.isFinite(issuedAt) || !Number.isFinite(expiration) || expiration <= now || issuedAt > now + 60_000 || expiration <= issuedAt || expiration - issuedAt > 15 * 60_000 || Math.abs(expiration / 1000 - expiresAt) > 1) throw new Error('The sign-in request has invalid or expired timestamps.');
}

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
    if (!wallet.address || !wallet.provider?.signMessage) { setError('Connect a wallet with message-signing support.'); return; }
    const epoch = generation.current;
    const address = wallet.address;
    setBusy(true); setError(null);
    try {
      const challenge = await post<{ nonce: string; message: string; expiresAt: number }>('/api/auth/nonce', { wallet: address });
      validateSignInMessage(challenge.message, address, challenge.nonce, challenge.expiresAt, cluster);
      if (wallet.provider.publicKey?.toString() !== address || generation.current !== epoch) throw new Error('Wallet changed. Sign in again.');
      const signed = await wallet.provider.signMessage(new TextEncoder().encode(challenge.message), 'utf8');
      if (wallet.provider.publicKey?.toString() !== address || generation.current !== epoch) throw new Error('Wallet changed. Sign in again.');
      const value = await post<Session>('/api/auth/verify', { wallet: address, nonce: challenge.nonce, signature: encodeSignature(signed.signature) });
      if (generation.current !== epoch) return;
      if (value.wallet !== address || value.expiresAt * 1000 <= Date.now() || !value.csrfToken) throw new Error('Invalid session response.');
      current.current = value; setSession(value); setCsrfToken(value.csrfToken);
    } catch (reason) { if (generation.current === epoch) setError(errorMessage(reason)); }
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
