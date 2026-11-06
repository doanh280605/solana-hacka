import type { PublicKey, Transaction } from '@holdfast/chain';

export type Order = {
  jobId: string;
  jobAddress: string;
  buyer: string;
  merchant: string;
  mint: string;
  amount: string;
  expiresAt: number;
  mode: 'normal' | 'stall';
  status: 'quoted' | 'funded' | 'processing' | 'ready' | 'released' | 'refunded' | 'failed';
  previewUrl?: string;
  error?: string;
};

export type InjectedWallet = {
  publicKey: PublicKey | null;
  isPhantom?: boolean;
  connect(options?: { onlyIfTrusted?: boolean }): Promise<{ publicKey: PublicKey }>;
  disconnect(): Promise<void>;
  signTransaction?: (transaction: Transaction) => Promise<Transaction>;
  signAndSendTransaction?: (transaction: Transaction) => Promise<{ signature: string }>;
  signMessage?: (message: Uint8Array, encoding?: string) => Promise<{ signature: Uint8Array }>;
  on?: (event: string, callback: (...args: unknown[]) => void) => void;
  removeListener?: (event: string, callback: (...args: unknown[]) => void) => void;
};

declare global {
  interface Window {
    phantom?: { solana?: InjectedWallet };
    solana?: InjectedWallet;
  }
}
