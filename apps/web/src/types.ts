import type { PublicKey, Transaction } from '@holdfast/chain';

export type Specification = {
  schemaVersion: 2;
  service: 'product-listing-pack';
  brief: string;
  productFacts: string[];
  imageDirection: string;
  deliverables: {
    hero: { width: 1600; height: 1600; format: 'webp' };
    social: { name: 'square' | 'portrait' | 'story'; width: number; height: number; format: 'webp' }[];
    copy: { titleMax: 80; descriptionMax: 1200; bulletCount: 5; bulletMax: 180 };
  };
  acceptanceChecks: string[];
  limitations: string[];
};
export type Listing = { title: string; description: string; bullets: string[] };
export type Validation = { schemaVersion: 2; passed: boolean; checks: { name: string; passed: boolean; detail: string }[]; limitations: string[] };
export type PreviewCommitment = { path: string; sourcePath: string; sha256: string; bytes: number; width: number; height: number; mimeType: 'image/webp' };
export type Manifest = {
  schemaVersion: 2;
  jobId: string;
  jobAddress: string;
  termsHash: string;
  specHash: string;
  inputHash: string;
  artifacts: { path: string; mediaType: string; size: number; sha256: string }[];
  previews: PreviewCommitment[];
};
export type Purchase = {
  version?: 1 | 2;
  jobId: string;
  jobAddress: string;
  buyer: string;
  merchant: string;
  mint: string;
  amount: string;
  expiresAt: number;
  mode: 'normal' | 'stall';
  status: 'quoted' | 'funded' | 'processing' | 'submitting' | 'ready' | 'released' | 'refunded' | 'failed';
  error?: string;
};
export type Order = Purchase & {
  version: 2;
  provider: string;
  quoteExpiresAt: number;
  inputHash: string;
  specHash: string;
  termsHash: string;
  specification: Specification;
  aiMode: 'live' | 'fixture';
  resultHash?: string;
  manifest?: Manifest;
  validation?: Validation;
  listing?: Listing;
  previews?: { name: string; url: string; width: number; height: number }[];
  submissionSignature?: string;
};
export type Session = { wallet: string; expiresAt: number; csrfToken: string };

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
  interface Window { phantom?: { solana?: InjectedWallet }; solana?: InjectedWallet }
}
