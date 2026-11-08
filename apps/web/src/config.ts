import { PublicKey, type PublicConfig } from '@holdfast/chain';

export const workerUrl = (import.meta.env.VITE_WORKER_URL || 'http://localhost:8787').replace(/\/$/, '');

export function validateConfig(value: unknown): PublicConfig {
  if (!value || typeof value !== 'object') throw new Error('Public chain configuration is missing.');
  const config = value as PublicConfig;
  for (const field of ['programId', 'mint', 'merchant'] as const) {
    try { new PublicKey(config[field]); } catch { throw new Error(`Invalid public ${field} configuration.`); }
  }
  if (config.provider) {
    try { new PublicKey(config.provider); } catch { throw new Error('Invalid public provider configuration.'); }
  }
  const rpc = new URL(config.rpcUrl);
  if (!['http:', 'https:'].includes(rpc.protocol)) throw new Error('RPC must use HTTP or HTTPS.');
  if (config.cluster !== 'localnet' && config.cluster !== 'devnet') throw new Error('Use localnet or Devnet test configuration.');
  if (config.amount !== '5000000' || config.decimals !== 6) throw new Error('This checkout requires 5 mock USDC with 6 decimals.');
  return config;
}

export function compiledConfig(): { config: PublicConfig | null; error: string | null } {
  try {
    const config = validateConfig({
      rpcUrl: import.meta.env.VITE_RPC_URL || 'https://api.devnet.solana.com',
      programId: import.meta.env.VITE_PROGRAM_ID,
      mint: import.meta.env.VITE_MINT,
      merchant: import.meta.env.VITE_MERCHANT,
      provider: import.meta.env.VITE_PROVIDER || undefined,
      cluster: import.meta.env.VITE_CLUSTER || 'devnet',
      decimals: 6,
      amount: '5000000',
    });
    return { config, error: null };
  } catch (error) {
    return { config: null, error: `Recovery configuration is incomplete. Set VITE_RPC_URL, VITE_PROGRAM_ID, VITE_MINT, VITE_MERCHANT and VITE_CLUSTER, then rebuild. ${errorMessage(error)}` };
  }
}

export function errorMessage(error: unknown): string {
  if (error instanceof Error) {
    if (/User rejected|user rejected|declined/i.test(error.message)) return 'Wallet request declined.';
    if (/Failed to fetch|NetworkError|fetch failed/i.test(error.message)) return 'Cannot reach this service. Check its URL and connection. Refresh Solana state before retrying a payment.';
    return error.message;
  }
  return String(error);
}
