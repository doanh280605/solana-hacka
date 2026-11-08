import type { Challenge, ImageManifest, Mode } from './types.js';

export interface Specification {
  schemaVersion: 2;
  service: 'product-listing-pack';
  brief: string;
  productFacts: string[];
  imageDirection: string;
  deliverables: {
    hero: { width: 1600; height: 1600; format: 'webp' };
    social: { name: string; width: number; height: number; format: 'webp' }[];
    copy: { titleMax: 80; descriptionMax: 1200; bulletCount: 5; bulletMax: 180 };
  };
  acceptanceChecks: string[];
  limitations: string[];
}

export interface Listing { title: string; description: string; bullets: string[] }
export interface Validation {
  schemaVersion: 2;
  passed: boolean;
  checks: { name: string; passed: boolean; detail: string }[];
  limitations: string[];
}
export interface Artifact { path: string; mediaType: string; size: number; sha256: string }
export interface ManifestPreview {
  path: string;
  sourcePath: string;
  sha256: string;
  bytes: number;
  width: number;
  height: number;
  mimeType: 'image/webp';
}
export interface ResultManifest {
  schemaVersion: 2;
  jobId: string;
  jobAddress: string;
  termsHash: string;
  specHash: string;
  inputHash: string;
  artifacts: Artifact[];
  previews: ManifestPreview[];
}
export type Stage = 'specification' | 'listing' | 'image';
export interface Attempt {
  id: string;
  stage: Stage;
  startedAt: number;
  state: 'pending' | 'completed' | 'failed' | 'uncertain';
  provider: 'openai' | 'fixture';
  requestId?: string;
  providerId?: string;
  completedAt?: number;
  error?: string;
}
export interface OrderV2 {
  version: 2;
  jobId: string;
  jobAddress: string;
  buyer: string;
  merchant: string;
  provider: string;
  mint: string;
  amount: string;
  expiresAt: number;
  quoteExpiresAt: number;
  inputHash: string;
  specHash: string;
  termsHash: string;
  specification: Specification;
  aiMode: 'live' | 'fixture';
  mode: Mode;
  status: 'quoted' | 'funded' | 'processing' | 'submitting' | 'ready' | 'released' | 'refunded' | 'failed';
  resultHash?: string;
  manifest?: ResultManifest;
  validation?: Validation;
  listing?: Listing;
  previews?: { name: string; url: string; width: number; height: number }[];
  submissionSignature?: string;
  attempts?: Attempt[];
  error?: string;
}
export interface StoredV2 extends Omit<OrderV2, 'previews'> {
  createdAt: number;
  updatedAt: number;
  quoteAccepted: boolean;
  input: ImageManifest;
  inputMediaType: string;
  fundingVerified?: boolean;
  chainState?: string;
  challenges: Challenge[];
  attempts: Attempt[];
  image?: { sha256: string; size: number };
  previewFiles?: Record<string, ImageManifest>;
  bundle?: { sha256: string; size: number };
  signedSubmission?: string;
}
