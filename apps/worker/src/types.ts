import type { Job, PublicConfig } from '@holdfast/chain';

export type OrderStatus = 'quoted' | 'funded' | 'processing' | 'ready' | 'released' | 'refunded' | 'failed';
export type Mode = 'normal' | 'stall';

export interface Order {
  jobId: string;
  jobAddress: string;
  buyer: string;
  merchant: string;
  mint: string;
  amount: string;
  expiresAt: number;
  mode: Mode;
  status: OrderStatus;
  previewUrl?: string;
  error?: string;
}

export interface ImageManifest {
  sha256: string;
  size: number;
  width: number;
  height: number;
}

export interface Challenge {
  nonce: string;
  message: string;
  expiresAt: number;
  used: boolean;
}

export interface StoredOrder extends Omit<Order, 'previewUrl'> {
  version: 1;
  createdAt: number;
  updatedAt: number;
  input: ImageManifest;
  output?: ImageManifest;
  preview?: ImageManifest;
  fundingVerified?: boolean;
  chainState?: Job['state'];
  challenges: Challenge[];
}

export interface VaultSnapshot {
  address: string;
  programOwner: string;
  mint: string;
  authority: string;
  amount: string;
  initialized: boolean;
}

/** Implementations must read finalized chain state, never transaction claims from HTTP. */
export interface ChainGateway {
  config: PublicConfig;
  validateAddress(address: string): boolean;
  deriveJob(buyer: string, jobId: string): string;
  deriveVault(jobAddress: string): string;
  getTime(): Promise<number>;
  readJob(address: string): Promise<Job | null>;
  readVault(address: string): Promise<VaultSnapshot | null>;
  publicKeyBytes(address: string): Uint8Array;
}

export interface WorkerSettings {
  dataDir: string;
  orderLifetimeSeconds: number;
  challengeLifetimeSeconds: number;
  challengeDomain: string;
  corsOrigins: string[];
}

export const TOKEN_PROGRAM = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA';
export const JOB_ID_PATTERN = /^[0-9a-f]{64}$/;
export const MAX_UPLOAD_BYTES = 5 * 1024 * 1024;
export const MAX_IMAGE_DIMENSION = 4096;
export const MAX_IMAGE_PIXELS = 4096 * 4096;
