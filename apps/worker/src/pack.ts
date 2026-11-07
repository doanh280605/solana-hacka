import sharp from 'sharp';
import { canonicalJson } from '@holdfast/chain';
import { HttpError } from './errors.js';
import { sha256 } from './security.js';
import { MAX_IMAGE_DIMENSION, MAX_IMAGE_PIXELS, MAX_UPLOAD_BYTES, type ImageManifest } from './types.js';
import type { Listing, Specification, Validation } from './v2-types.js';

export const PACK_LIMITATIONS = [
  'Automated checks verify dimensions, fields and artifact bytes; they do not prove aesthetic quality or factual correctness.',
  'Review product identity, text, and every image before approving payment.',
  'Files depend on service storage availability. Refunds require an explicit buyer transaction after the deadline.',
];
export function specification(brief: string, facts: string[], direction: string): Specification {
  return {
    schemaVersion: 2, service: 'product-listing-pack', brief, productFacts: facts, imageDirection: direction,
    deliverables: {
      hero: { width: 1600, height: 1600, format: 'webp' },
      social: [
        { name: 'square', width: 1080, height: 1080, format: 'webp' },
        { name: 'portrait', width: 1080, height: 1350, format: 'webp' },
        { name: 'story', width: 1080, height: 1920, format: 'webp' },
      ],
      copy: { titleMax: 80, descriptionMax: 1200, bulletCount: 5, bulletMax: 180 },
    },
    acceptanceChecks: ['Four WebP images at the agreed dimensions', 'Title 1–80 characters; description 1–1200 characters',
      'Exactly five nonempty bullets, each at most 180 characters', 'Six payload files with SHA-256 hashes in a versioned manifest',
      'Validation report and manifest included in the downloadable ZIP'],
    limitations: PACK_LIMITATIONS,
  };
}
export async function validateProductImage(bytes: Buffer, generated = false): Promise<{ manifest: ImageManifest; mediaType: string }> {
  if (!bytes.length || bytes.length > (generated ? 25 * 1024 * 1024 : MAX_UPLOAD_BYTES)) throw new HttpError(413, 'Upload one image of at most 5 MiB');
  try {
    const meta = await sharp(bytes, { limitInputPixels: MAX_IMAGE_PIXELS, failOn: 'warning' }).metadata();
    const width = meta.width ?? 0;
    const height = meta.height ?? 0;
    if (!['png', 'jpeg', 'webp'].includes(meta.format ?? '') || (meta.pages ?? 1) !== 1 || width < 1 || height < 1
      || width > MAX_IMAGE_DIMENSION || height > MAX_IMAGE_DIMENSION) throw new Error('Unsupported image');
    await sharp(bytes, { limitInputPixels: MAX_IMAGE_PIXELS, failOn: 'warning' }).raw().toBuffer();
    return { manifest: { sha256: sha256(bytes), size: bytes.length, width, height }, mediaType: `image/${meta.format}` };
  } catch { throw new HttpError(generated ? 502 : 400, 'Use a valid single-frame PNG, JPEG or WebP, up to 4096 × 4096 pixels'); }
}
export function validInterpretation(value: unknown, brief: string): { productFacts: string[]; imageDirection: string } {
  if (!value || typeof value !== 'object') throw new HttpError(502, 'AI returned an invalid specification');
  const data = value as Record<string, unknown>;
  if (Object.keys(data).sort().join(',') !== 'imageDirection,productFacts' || !Array.isArray(data.productFacts)
    || data.productFacts.length > 20 || data.productFacts.some(f => typeof f !== 'string' || !f.trim() || f.length > 500 || !brief.includes(f))
    || typeof data.imageDirection !== 'string' || !data.imageDirection.trim() || data.imageDirection.length > 1600) {
    throw new HttpError(502, 'AI specification contained unsupported facts or invalid fields');
  }
  return { productFacts: data.productFacts as string[], imageDirection: data.imageDirection };
}

function positiveSellerClauses(brief: string): string[] {
  return brief.toLowerCase().split(/(?<=[.!?;])\s+|\n/).filter(clause => {
    // "when not in use" is a condition, not a negated product assertion.
    const assertion = clause.replace(/\b(?:when|while|if)\s+not\s+in\s+use\b/g, '');
    return !/\b(?:no|not|never|avoid|without|neither|nor|lack|lacks|lacking|cannot|(?:do|does|did|is|are|was|were|has|have|had|ca|could|wo|would|should|must)n['’]t)\b/.test(assertion)
      && !NEGATED_BENEFIT_WORDING.test(assertion);
  });
}
function claimWords(value: string): string { return value.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim(); }

// This is deliberately bounded lexical coverage, not general semantic fact checking.
// A detected benefit requires equality with a complete positive seller clause: qualifiers cannot be dropped.
const BENEFIT_WORDING_SOURCE = String.raw`sturdy|sturdiness|durable|durability|robust|resilient|resilience|heavy[-\s]?duty|long[-\s]?lasting|shatterproof|break[-\s]?resistant|fresh|freshness|preserve|preserves|preserving|preservation|airtight|leakproof|protect|protects|protective|protection|safe|safer|safety|non[-\s]?toxic|therapeutic|soothing|relaxing|relaxation|calming|antibacterial|hypoallergenic|premium|high[-\s]?quality|superior|reliable|reusable|sustainable|sustainability|eco[-\s]?friendly|keeps?|keeping|ensures?|ensuring|prevents?|preventing|retains?|retaining|maintains?|maintaining|reduces?|reducing|improves?|improving|boosts?|boosting|enhances?|enhancing|seals?|sealing`;
const BENEFIT_WORDING = new RegExp(String.raw`\b(?:${BENEFIT_WORDING_SOURCE})\b`, 'i');
const NEGATED_BENEFIT_WORDING = new RegExp(String.raw`\b(?:non|un)[-\s]*(?:${BENEFIT_WORDING_SOURCE})\b`, 'i');
export function validListing(value: unknown, spec: Specification): Listing {
  if (!value || typeof value !== 'object') throw new HttpError(502, 'AI returned invalid listing copy');
  const data = value as Record<string, unknown>;
  const limits = spec.deliverables.copy;
  if (Object.keys(data).sort().join(',') !== 'bullets,description,title' || typeof data.title !== 'string' || !data.title.trim() || data.title.length > limits.titleMax
    || typeof data.description !== 'string' || !data.description.trim() || data.description.length > limits.descriptionMax
    || !Array.isArray(data.bullets) || data.bullets.length !== limits.bulletCount
    || data.bullets.some(b => typeof b !== 'string' || !b.trim() || b.length > limits.bulletMax)) throw new HttpError(502, 'AI listing copy did not meet the agreed limits');
  // Reject newly invented numeric claims and named certification/price assertions.
  // Negative instructions such as "no prices or certifications" do not support claims.
  const sourceClauses = positiveSellerClauses(spec.brief);
  const source = sourceClauses.join(' ');
  const text = `${data.title} ${data.description} ${(data.bullets as string[]).join(' ')}`;
  const numbers = new Set(source.match(/\d+(?:[.,]\d+)?/g) ?? []);
  const claims = new Set(source.match(/\b(?:certified|certification|organic|waterproof|guaranteed|fda|ce-marked|prices?)\b|[$€£]/g) ?? []);
  const newNumbers = text.match(/\d+(?:[.,]\d+)?/g) ?? [];
  const newClaims = text.toLowerCase().match(/\b(?:certified|certification|organic|waterproof|guaranteed|fda|ce-marked|prices?)\b|[$€£]/g) ?? [];
  if (newNumbers.some(token => !numbers.has(token)) || newClaims.some(token => !claims.has(token))) throw new HttpError(502, 'AI listing copy introduced an unsupported measurable or certification claim');
  const positiveClaims = sourceClauses.map(claimWords);
  const statements = [data.title, data.description, ...(data.bullets as string[])].flatMap(part => part.split(/[.!?;\n]+/));
  for (const statement of statements) {
    if (BENEFIT_WORDING.test(statement)) {
      const claim = claimWords(statement);
      if (!positiveClaims.includes(claim)) throw new HttpError(502, 'AI listing copy introduced an unsupported functional, freshness, durability, health or quality claim');
    }
  }
  return { title: data.title, description: data.description, bullets: data.bullets as string[] };
}
export interface ImagePack { files: Record<string, Buffer>; previews: Record<string, { bytes: Buffer; manifest: ImageManifest }> }
export async function buildImages(edited: Buffer, spec: Specification): Promise<ImagePack> {
  await validateProductImage(edited, true);
  const files: Record<string, Buffer> = {};
  const previews: ImagePack['previews'] = {};
  const sizes = [{ name: 'hero', ...spec.deliverables.hero }, ...spec.deliverables.social];
  for (const size of sizes) {
    const name = size.name === 'hero' ? 'hero.webp' : `social-${size.name}.webp`;
    // Contain preserves the entire edited product; the provider performs the creative edit.
    const output = await sharp(edited, { limitInputPixels: MAX_IMAGE_PIXELS }).rotate()
      .resize(size.width, size.height, { fit: 'contain', background: '#f4f1ea' }).webp({ quality: 92 }).toBuffer();
    files[name] = output;
    const { data: thumbnail, info } = await sharp(output).resize({ width: 560, height: 680, fit: 'inside', withoutEnlargement: true }).webp().toBuffer({ resolveWithObject: true });
    const overlay = Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${info.width}" height="${info.height}"><defs><pattern id="p" width="100" height="70" patternTransform="rotate(-28)" patternUnits="userSpaceOnUse"><text x="0" y="35" font-family="sans-serif" font-size="18" font-weight="bold" fill="white" stroke="#1e2520" stroke-width="0.6" opacity="0.5">osid preview</text></pattern></defs><rect width="100%" height="100%" fill="url(#p)"/><rect y="${info.height - 28}" width="100%" height="28" fill="#1e2520"/><text x="${info.width / 2}" y="${info.height - 9}" text-anchor="middle" font-family="sans-serif" font-size="11" fill="white">osid · review before release</text></svg>`);
    const bytes = await sharp(thumbnail).composite([{ input: overlay }]).webp({ quality: 76 }).toBuffer();
    previews[size.name] = { bytes, manifest: { sha256: sha256(bytes), size: bytes.length, width: info.width, height: info.height } };
  }
  return { files, previews };
}
export async function validatePack(files: Record<string, Buffer>, listing: Listing, spec: Specification): Promise<Validation> {
  const checks: Validation['checks'] = [];
  const expected = [{ name: 'hero.webp', ...spec.deliverables.hero }, ...spec.deliverables.social.map(s => ({ ...s, name: `social-${s.name}.webp` }))];
  for (const file of expected) {
    const bytes = files[file.name];
    const meta = bytes ? await sharp(bytes).metadata() : undefined;
    checks.push({ name: file.name, passed: !!bytes && meta?.format === 'webp' && meta.width === file.width && meta.height === file.height,
      detail: `${file.width} × ${file.height} WebP required` });
  }
  let copyPassed = true;
  try { validListing(listing, spec); } catch { copyPassed = false; }
  checks.push({ name: 'Listing fields and limits', passed: copyPassed, detail: 'Nonempty title, description, and five bullets within agreed limits; bounded checks for unsupported numbers, certifications and benefit wording' });
  checks.push({ name: 'Payload completeness', passed: Object.keys(files).sort().join(',') === 'hero.webp,listing.json,social-portrait.webp,social-square.webp,social-story.webp',
    detail: 'Four image exports and listing.json exist; validation.json is added after these checks' });
  return { schemaVersion: 2, passed: checks.every(c => c.passed), checks, limitations: PACK_LIMITATIONS };
}
export function jsonBytes(value: unknown): Buffer { return Buffer.from(canonicalJson(value), 'utf8'); }

function crc32(bytes: Buffer): number {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
  }
  return (crc ^ 0xffffffff) >>> 0;
}
/** Minimal ZIP32 store writer: fixed safe names, CRC32, no compression or platform paths. */
export function zipBundle(files: Record<string, Buffer>): Buffer {
  const local: Buffer[] = [];
  const central: Buffer[] = [];
  let offset = 0;
  for (const name of Object.keys(files).sort()) {
    if (!/^[a-z][a-z-]*\.(webp|json)$/.test(name)) throw new Error('Unsafe bundle path');
    const data = files[name]!;
    if (data.length > 25 * 1024 * 1024) throw new Error('Artifact exceeds bundle limit');
    const path = Buffer.from(name);
    const crc = crc32(data);
    const header = Buffer.alloc(30);
    header.writeUInt32LE(0x04034b50, 0); header.writeUInt16LE(20, 4); header.writeUInt16LE(0x800, 6);
    header.writeUInt16LE(33, 12); // Fixed 1980-01-01 DOS date keeps bundles deterministic.
    header.writeUInt32LE(crc, 14); header.writeUInt32LE(data.length, 18); header.writeUInt32LE(data.length, 22); header.writeUInt16LE(path.length, 26);
    local.push(header, path, data);
    const directory = Buffer.alloc(46);
    directory.writeUInt32LE(0x02014b50, 0); directory.writeUInt16LE(20, 4); directory.writeUInt16LE(20, 6); directory.writeUInt16LE(0x800, 8);
    directory.writeUInt16LE(33, 14);
    directory.writeUInt32LE(crc, 16); directory.writeUInt32LE(data.length, 20); directory.writeUInt32LE(data.length, 24); directory.writeUInt16LE(path.length, 28);
    directory.writeUInt32LE(offset, 42); central.push(directory, path);
    offset += header.length + path.length + data.length;
  }
  const centralBytes = Buffer.concat(central);
  const end = Buffer.alloc(22); end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(Object.keys(files).length, 8); end.writeUInt16LE(Object.keys(files).length, 10);
  end.writeUInt32LE(centralBytes.length, 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat([...local, centralBytes, end]);
}
