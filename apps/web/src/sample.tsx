import type { Listing, Specification, Validation } from './types';

export const sampleBrief = 'Create a warm, minimal listing for Morning, our 250 g cedar and amber candle in an amber glass jar with a cotton wick. Keep the original jar, label, shape and color. Use a soft cream studio background. Do not add burn time, certifications or sustainability claims.';
export const sampleListing: Listing = {
  title: 'Morning — Cedar & Amber Candle, 250 g',
  description: 'A little warmth for your everyday space. Morning pairs cedar and amber fragrance in an amber glass jar, finished with a cotton wick. The simple label keeps the focus on the candle. Net weight: 250 g.',
  bullets: ['Cedar and amber fragrance', '250 g net weight', 'Amber glass jar', 'Cotton wick', 'Original Morning label and understated design'],
};
export const sampleSpec: Specification = {
  schemaVersion: 2, service: 'product-listing-pack', brief: sampleBrief,
  productFacts: ['Product: Morning candle', 'Cedar and amber fragrance', '250 g net weight', 'Amber glass jar', 'Cotton wick'],
  imageDirection: 'A warm cream studio setting with a soft directional shadow. Preserve the original jar, lid, proportions, color and label. No added claims or props that alter the product.',
  deliverables: { hero: { width: 1600, height: 1600, format: 'webp' }, social: [{ name: 'square', width: 1080, height: 1080, format: 'webp' }, { name: 'portrait', width: 1080, height: 1350, format: 'webp' }, { name: 'story', width: 1080, height: 1920, format: 'webp' }], copy: { titleMax: 80, descriptionMax: 1200, bulletCount: 5, bulletMax: 180 } },
  acceptanceChecks: ['One 1600 × 1600 WebP hero image', 'Three WebP social exports at agreed dimensions', 'Nonempty title, description and exactly five bullets within agreed limits', 'Six payload hashes recorded in a complete artifact manifest'],
  limitations: ['Dimensions and hashes do not measure aesthetic quality.', 'Check the images and all product facts before approving.'],
};
export const sampleValidation: Validation = {
  schemaVersion: 2, passed: true,
  checks: [{ name: 'Image formats & dimensions', passed: true, detail: '1 hero + 3 social exports at the agreed sizes.' }, { name: 'Listing structure & copy limits', passed: true, detail: 'Title, description and 5 bullets fit the specification.' }, { name: 'Bundle & manifest', passed: true, detail: 'All 6 payload files are present with SHA-256 hashes.' }],
  limitations: ['Illustrated fixture walkthrough. No AI request, payment or validation ran for this sample.', 'Measurable checks do not establish aesthetic quality or factual correctness.'],
};

export function ProductArt({ polished = true, className = '' }: { polished?: boolean; className?: string }) {
  return <img className={`product-art ${className}`} src={polished ? '/sample-after.webp' : '/sample-before.webp'} width="1254" height="1254" alt={polished ? 'Synthetic sample: Morning amber candle in a cream studio setting' : 'Synthetic sample: original Morning amber candle on a gray table'} />;
}
