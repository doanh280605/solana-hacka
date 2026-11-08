import { resolve } from 'node:path';
import { PublicKey, type PublicConfig } from '@holdfast/chain';
import type { WorkerSettings } from './types.js';

function required(env: NodeJS.ProcessEnv, name: string): string {
  const value = env[name]?.trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function integer(env: NodeJS.ProcessEnv, name: string, fallback: number, min: number, max: number): number {
  const raw = env[name] ?? String(fallback);
  if (!/^\d+$/.test(raw)) throw new Error(`${name} must be an integer`);
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < min || value > max) throw new Error(`${name} must be between ${min} and ${max}`);
  return value;
}

function address(env: NodeJS.ProcessEnv, name: string): string {
  const value = required(env, name);
  if (new PublicKey(value).toBase58() !== value) throw new Error(`${name} must be a canonical Solana public key`);
  return value;
}

function httpUrl(raw: string, name: string): URL {
  const url = new URL(raw);
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) {
    throw new Error(`${name} must be an HTTP(S) URL without credentials, query, or fragment`);
  }
  return url;
}

export function loadConfiguration(env: NodeJS.ProcessEnv = process.env): {
  config: PublicConfig; settings: WorkerSettings; host: string; port: number;
} {
  const cluster = required(env, 'CLUSTER');
  if (cluster !== 'localnet' && cluster !== 'devnet') throw new Error('CLUSTER must be localnet or devnet');
  const rpcUrl = required(env, 'RPC_URL');
  httpUrl(rpcUrl, 'RPC_URL');
  const port = integer(env, 'WORKER_PORT', 8787, 1, 65535);
  const origin = httpUrl(env.WORKER_PUBLIC_ORIGIN ?? `http://localhost:${port}`, 'WORKER_PUBLIC_ORIGIN').origin;
  const corsOrigins = (env.CORS_ORIGINS ?? 'http://localhost:5173,http://localhost:4173').split(',')
    .map(value => httpUrl(value.trim(), 'CORS_ORIGINS').origin);
  const aiMode = env.AI_MODE ?? 'live';
  if (aiMode !== 'live' && aiMode !== 'fixture') throw new Error('AI_MODE must be live or fixture');
  const executionLifetimeSeconds = integer(env, 'OSID_ORDER_LIFETIME_SECONDS', 1800, 5, 86400);
  const quoteLifetimeSeconds = integer(env, 'OSID_QUOTE_LIFETIME_SECONDS', 600, 1, 3600);
  if (quoteLifetimeSeconds >= executionLifetimeSeconds) throw new Error('OSID_ORDER_LIFETIME_SECONDS must exceed OSID_QUOTE_LIFETIME_SECONDS');
  return {
    config: {
      rpcUrl,
      programId: address(env, 'PROGRAM_ID'),
      mint: address(env, 'MINT'),
      merchant: address(env, 'MERCHANT'),
      ...(env.PROVIDER ? { provider: address(env, 'PROVIDER') } : {}),
      decimals: 6,
      amount: '5000000',
      cluster,
    },
    settings: {
      dataDir: resolve(env.WORKER_DATA_DIR ?? '.local/worker'),
      orderLifetimeSeconds: integer(env, 'ORDER_LIFETIME_SECONDS', 120, 5, 86400),
      challengeLifetimeSeconds: integer(env, 'CHALLENGE_LIFETIME_SECONDS', 60, 5, 300),
      challengeDomain: origin,
      corsOrigins,
      aiMode,
      ...(env.OPENAI_API_KEY ? { openaiApiKey: env.OPENAI_API_KEY } : {}),
      openaiTextModel: env.OPENAI_TEXT_MODEL ?? 'gpt-4.1-mini',
      openaiImageModel: env.OPENAI_IMAGE_MODEL ?? 'gpt-image-1.5',
      aiTimeoutMs: integer(env, 'AI_TIMEOUT_MS', 240000, 1000, 600000),
      quoteLifetimeSeconds, executionLifetimeSeconds,
      sessionLifetimeSeconds: integer(env, 'SESSION_LIFETIME_SECONDS', 3600, 60, 86400),
      allowRehearsalStall: env.OSID_ALLOW_REHEARSAL_STALL === 'true',
      maxQuotesPerHour: integer(env, 'OSID_MAX_QUOTES_PER_HOUR', 6, 1, 100),
      maxConcurrentGenerations: integer(env, 'OSID_MAX_CONCURRENT_GENERATIONS', 2, 1, 8),
    },
    host: env.WORKER_HOST ?? '127.0.0.1',
    port,
  };
}
