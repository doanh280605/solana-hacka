import { randomBytes } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { FastifyRequest } from 'fastify';
import { HttpError, isMissing } from './errors.js';
import { atomicWrite, OrderLocks } from './persistence.js';
import { sha256, verifyWalletSignature } from './security.js';
import type { ChainGateway, WorkerSettings } from './types.js';

interface Nonce { wallet: string; nonce: string; origin: string; message: string; expiresAt: number; used: boolean }
interface Session { wallet: string; origin: string; tokenHash: string; csrfToken: string; expiresAt: number }
interface State { version: 2; nonces: Nonce[]; sessions: Session[] }
export interface PublicSession { wallet: string; expiresAt: number; csrfToken: string }
export const SESSION_COOKIE = 'osid_session';
export class WalletAuth {
  private state: State = { version: 2, nonces: [], sessions: [] };
  private readonly locks = new OrderLocks();
  private readonly nonceRates = new Map<string, number[]>();
  constructor(private readonly chain: ChainGateway, private readonly settings: WorkerSettings) {}
  private get file(): string { return join(this.settings.dataDir, 'authentication.json'); }
  async initialize(): Promise<void> {
    try {
      const parsed = JSON.parse(await readFile(this.file, 'utf8')) as State;
      if (parsed.version !== 2 || !Array.isArray(parsed.nonces) || !Array.isArray(parsed.sessions)
        || parsed.nonces.some(n => !n || typeof n.nonce !== 'string' || !/^[0-9a-f]{64}$/.test(n.nonce)
          || typeof n.wallet !== 'string' || !this.chain.validateAddress(n.wallet) || typeof n.message !== 'string'
          || !this.settings.corsOrigins.includes(n.origin) || !Number.isSafeInteger(n.expiresAt) || typeof n.used !== 'boolean')
        || parsed.sessions.some(s => !s || typeof s.tokenHash !== 'string' || !/^[0-9a-f]{64}$/.test(s.tokenHash)
          || typeof s.wallet !== 'string' || !this.chain.validateAddress(s.wallet) || !this.settings.corsOrigins.includes(s.origin)
          || !Number.isSafeInteger(s.expiresAt) || typeof s.csrfToken !== 'string' || !/^[0-9a-f]{64}$/.test(s.csrfToken))) {
        throw new Error('Authentication metadata is invalid');
      }
      this.state = parsed;
    } catch (error) { if (!isMissing(error)) throw error; }
    await this.persist();
  }
  private async persist(): Promise<void> {
    const now = Math.floor(Date.now() / 1000);
    this.state.nonces = this.state.nonces.filter(n => n.expiresAt > now);
    this.state.sessions = this.state.sessions.filter(s => s.expiresAt > now);
    await atomicWrite(this.file, Buffer.from(JSON.stringify(this.state)));
  }
  origin(request: FastifyRequest): string {
    const origin = request.headers.origin;
    if (!origin || !this.settings.corsOrigins.includes(origin)) throw new HttpError(403, 'A trusted application origin is required');
    return origin;
  }
  private rate(key: string, maximum: number): void {
    const now = Math.floor(Date.now() / 1000);
    if (this.nonceRates.size > 2000) for (const [name, timestamps] of this.nonceRates) if ((timestamps.at(-1) ?? 0) <= now - 60) this.nonceRates.delete(name);
    if (!this.nonceRates.has(key) && this.nonceRates.size >= 4096) throw new HttpError(429, 'Sign-in capacity reached; retry shortly');
    const recent = (this.nonceRates.get(key) ?? []).filter(n => n > now - 60);
    if (recent.length >= maximum) throw new HttpError(429, 'Too many sign-in attempts; try again in one minute');
    this.nonceRates.set(key, [...recent, now]);
  }
  async nonce(wallet: unknown, request: FastifyRequest): Promise<{ nonce: string; message: string; expiresAt: number }> {
    const origin = this.origin(request);
    if (typeof wallet !== 'string' || !this.chain.validateAddress(wallet)) throw new HttpError(400, 'wallet must be a Solana public key');
    this.rate(`nonce-ip:${request.ip}`, 30);
    this.rate(`nonce-wallet:${wallet}`, 10);
    return this.locks.run('auth', async () => {
      const now = Math.floor(Date.now() / 1000);
      const active = this.state.nonces.find(n => n.wallet === wallet && n.origin === origin && !n.used && n.expiresAt > now);
      if (active) return { nonce: active.nonce, message: active.message, expiresAt: active.expiresAt };
      if (this.state.nonces.filter(n => n.expiresAt > now).length >= 1000) throw new HttpError(429, 'Sign-in capacity reached; retry shortly');
      const nonce = randomBytes(32).toString('hex');
      const expiresAt = now + 300;
      const message = [
        `${new URL(origin).host} wants you to sign in with your Solana account:`, wallet, '',
        'Sign in to osid (no payment authorization)', '', `URI: ${origin}/app`, 'Version: 1',
        `Chain ID: ${this.chain.config.cluster}`, `Nonce: ${nonce}`,
        `Issued At: ${new Date(now * 1000).toISOString()}`, `Expiration Time: ${new Date(expiresAt * 1000).toISOString()}`,
      ].join('\n');
      this.state.nonces.push({ wallet, nonce, origin, message, expiresAt, used: false });
      await this.persist();
      return { nonce, message, expiresAt };
    });
  }
  async verify(wallet: unknown, nonce: unknown, signature: unknown, request: FastifyRequest): Promise<{ session: PublicSession; cookie: string }> {
    const origin = this.origin(request);
    this.rate(`verify-ip:${request.ip}`, 30);
    return this.locks.run('auth', async () => {
      const now = Math.floor(Date.now() / 1000);
      const challenge = this.state.nonces.find(n => n.nonce === nonce && n.wallet === wallet && n.origin === origin);
      if (!challenge || challenge.used || challenge.expiresAt <= now) throw new HttpError(401, 'Sign-in nonce is invalid, expired, or already used');
      if (!verifyWalletSignature(this.chain.publicKeyBytes(challenge.wallet), challenge.message, signature)) throw new HttpError(403, 'Wallet signature is invalid');
      const token = randomBytes(32).toString('base64url');
      const session: Session = {
        wallet: challenge.wallet, origin, tokenHash: sha256(Buffer.from(token)),
        csrfToken: randomBytes(32).toString('hex'), expiresAt: now + (this.settings.sessionLifetimeSeconds ?? 3600),
      };
      challenge.used = true;
      // Rotate any session cookie presented during login, including wallet changes.
      const previous = this.token(request);
      if (previous) this.state.sessions = this.state.sessions.filter(s => s.tokenHash !== sha256(Buffer.from(previous)));
      this.state.sessions.push(session);
      await this.persist();
      return { session: this.public(session), cookie: this.cookie(token, session.expiresAt - now) };
    });
  }
  private token(request: FastifyRequest): string | undefined {
    const entries = (request.headers.cookie ?? '').split(';').map(item => item.trim());
    const candidates = entries.filter(item => item.startsWith(`${SESSION_COOKIE}=`));
    if (candidates.length !== 1) return undefined;
    const token = candidates[0]!.slice(SESSION_COOKIE.length + 1);
    return /^[A-Za-z0-9_-]{43}$/.test(token) ? token : undefined;
  }
  private cookie(token: string, age: number): string {
    const secure = new URL(this.settings.challengeDomain).protocol === 'https:' ? '; Secure' : '';
    return `${SESSION_COOKIE}=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${age}${secure}`;
  }
  private public(session: Session): PublicSession { return { wallet: session.wallet, expiresAt: session.expiresAt, csrfToken: session.csrfToken }; }
  require(request: FastifyRequest, mutate = false): PublicSession {
    const token = this.token(request);
    const session = token ? this.state.sessions.find(s => s.tokenHash === sha256(Buffer.from(token))) : undefined;
    if (!session || session.expiresAt <= Math.floor(Date.now() / 1000)) throw new HttpError(401, 'Sign in with your wallet');
    if (request.headers.origin && request.headers.origin !== session.origin) throw new HttpError(403, 'Session origin does not match');
    if (mutate && (this.origin(request) !== session.origin || request.headers['x-osid-csrf'] !== session.csrfToken)) throw new HttpError(403, 'CSRF validation failed');
    return this.public(session);
  }
  async logout(request: FastifyRequest): Promise<string> {
    this.require(request, true);
    return this.locks.run('auth', async () => {
      const token = this.token(request)!;
      this.state.sessions = this.state.sessions.filter(s => s.tokenHash !== sha256(Buffer.from(token)));
      await this.persist();
      return this.cookie('', 0);
    });
  }
}
