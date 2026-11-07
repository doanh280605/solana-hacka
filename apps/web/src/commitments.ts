import { canonicalJson, computeTermsHash, deriveJobV2Address, hashCanonical, type Job, type PublicConfig } from '@holdfast/chain';
import type { Manifest, Order, Specification } from './types';
import { committedPreviews } from './previews';
export { hashBytes } from './bytes';

const hashPattern = /^[a-f0-9]{64}$/;
const requiredArtifacts = ['hero.webp', 'listing.json', 'social-portrait.webp', 'social-square.webp', 'social-story.webp', 'validation.json'];

export function validateSpecification(value: Specification): void {
  if (!value || value.schemaVersion !== 2 || value.service !== 'product-listing-pack' || typeof value.brief !== 'string' || value.brief.length < 20 || value.brief.length > 2000 || !Array.isArray(value.productFacts) || value.productFacts.length > 20 || value.productFacts.some((fact) => typeof fact !== 'string' || !fact.trim() || fact.length > 500 || !value.brief.includes(fact)) || typeof value.imageDirection !== 'string' || !value.imageDirection.trim() || value.imageDirection.length > 1600) throw new Error('The quoted specification is invalid.');
  const { hero, social, copy } = value.deliverables || {};
  const expected = [['square', 1080, 1080], ['portrait', 1080, 1350], ['story', 1080, 1920]];
  if (!hero || hero.width !== 1600 || hero.height !== 1600 || hero.format !== 'webp' || !Array.isArray(social) || social.length !== 3 || expected.some(([name, width, height]) => !social.some((item) => item.name === name && item.width === width && item.height === height && item.format === 'webp')) || !copy || copy.titleMax !== 80 || copy.descriptionMax !== 1200 || copy.bulletCount !== 5 || copy.bulletMax !== 180 || !Array.isArray(value.acceptanceChecks) || !value.acceptanceChecks.length || value.acceptanceChecks.some((check) => typeof check !== 'string') || !Array.isArray(value.limitations) || value.limitations.some((item) => typeof item !== 'string')) throw new Error('The quote does not include the agreed product-listing pack.');
}

export async function assertOrder(order: Order, config: PublicConfig, buyer: string, job?: Job | null): Promise<void> {
  if (order.version !== 2 || order.buyer !== buyer) throw new Error('This quote belongs to another wallet or service version. Reconnect the original buyer.');
  if (!config.provider || order.provider !== config.provider || !hashPattern.test(order.jobId) || order.mint !== config.mint || order.merchant !== config.merchant || order.amount !== config.amount || !Number.isSafeInteger(order.expiresAt) || !Number.isSafeInteger(order.quoteExpiresAt) || order.quoteExpiresAt >= order.expiresAt || !['live', 'fixture'].includes(order.aiMode) || ![order.inputHash, order.specHash, order.termsHash].every((hash) => typeof hash === 'string' && hashPattern.test(hash))) throw new Error('The quote does not match the trusted payment configuration. Create a new quote.');
  if (deriveJobV2Address(config, buyer, order.jobId).toString() !== order.jobAddress) throw new Error('The job address does not match this buyer and quote.');
  validateSpecification(order.specification);
  if (await hashCanonical(order.specification) !== order.specHash) throw new Error('The quoted specification has changed. Do not fund this order.');
  const termsHash = await computeTermsHash({ programId: config.programId, jobAddress: order.jobAddress, jobId: order.jobId, buyer, merchant: order.merchant, provider: order.provider, mint: order.mint, amount: order.amount, expiresAt: order.expiresAt, quoteExpiresAt: order.quoteExpiresAt, inputHash: order.inputHash, specHash: order.specHash });
  if (termsHash !== order.termsHash) throw new Error('The payment terms commitment does not match this quote.');
  if (job && (job.version !== 2 || job.address !== order.jobAddress || job.buyer !== buyer || job.mint !== order.mint || job.merchant !== order.merchant || job.provider !== order.provider || job.amount !== order.amount || job.expiresAt !== order.expiresAt || job.quoteExpiresAt !== order.quoteExpiresAt || job.jobId !== order.jobId || job.inputHash !== order.inputHash || job.specHash !== order.specHash || job.termsHash !== order.termsHash)) throw new Error('The onchain purchase does not match the agreed specification and payment. Do not approve it.');
}

export async function assertResult(order: Order, job: Job): Promise<void> {
  const manifest: Manifest | undefined = order.manifest;
  if (!manifest || !order.resultHash || !hashPattern.test(order.resultHash) || job.resultHash !== order.resultHash || !['Submitted', 'Released'].includes(job.state)) throw new Error('A matching submitted result has not been confirmed on Solana.');
  if (manifest.schemaVersion !== 2 || manifest.jobId !== order.jobId || manifest.jobAddress !== order.jobAddress || manifest.inputHash !== order.inputHash || manifest.specHash !== order.specHash || manifest.termsHash !== order.termsHash || !Array.isArray(manifest.artifacts) || manifest.artifacts.length !== requiredArtifacts.length || requiredArtifacts.some((path) => manifest.artifacts.filter((item) => item.path === path).length !== 1) || manifest.artifacts.some((item) => !hashPattern.test(item.sha256) || !Number.isSafeInteger(item.size) || item.size <= 0 || item.mediaType !== (item.path.endsWith('.webp') ? 'image/webp' : 'application/json'))) throw new Error('The submitted bundle manifest is incomplete or belongs to different terms.');
  if (await hashCanonical(manifest) !== order.resultHash) throw new Error('The preview manifest differs from the result committed on Solana.');
  if (order.validation?.schemaVersion !== 2 || order.validation.passed !== true || !Array.isArray(order.validation.checks) || !order.validation.checks.length || order.validation.checks.some((check) => check.passed !== true || typeof check.name !== 'string' || typeof check.detail !== 'string')) throw new Error('This pack has not passed the agreed measurable checks.');
  if (!order.listing || !order.listing.title.trim() || order.listing.title.length > 80 || !order.listing.description.trim() || order.listing.description.length > 1200 || order.listing.bullets.length !== 5 || order.listing.bullets.some((bullet) => !bullet.trim() || bullet.length > 180)) throw new Error('The listing copy is incomplete or exceeds the agreed limits.');
  if (!order.previews || order.previews.length !== 4 || ['hero', 'square', 'portrait', 'story'].some((name) => order.previews!.filter((preview) => preview.name === name).length !== 1)) throw new Error('The image review set is incomplete.');
  committedPreviews(manifest, order.previews);
  for (const [path, value] of [['listing.json', order.listing], ['validation.json', order.validation]] as const) {
    const entry = manifest.artifacts.find((artifact) => artifact.path === path)!;
    if (new TextEncoder().encode(canonicalJson(value)).byteLength !== entry.size || await hashCanonical(value) !== entry.sha256) throw new Error(`The displayed ${path} differs from the committed result. Do not approve it.`);
  }
}
