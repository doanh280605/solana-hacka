import { HttpError } from './errors.js';
import type { Listing } from './v2-types.js';

// Deliberately small grammar vocabulary: no inferred materials, benefits, weights or scene descriptions.
const CONNECTORS = new Set('a an and the with in of for on to from at by or as is are has have its this that these those'.split(' '));
function words(value: string): string[] { return value.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? []; }
function normalizedClause(value: string): string {
  return value.toLowerCase().trim().replace(/[.!?;]+$/u, '').replace(/\s+/gu, ' ').trim();
}
function clauses(value: string): string[] {
  // Sentence delimiters split facts; decimal points between number characters remain intact.
  return value.split(/(?<!\p{N})\.|\.(?!\p{N})|[!?;\n]+/u).map(normalizedClause).filter(Boolean);
}

/**
 * Conservative live-only lexical/phrase grounding, not semantic or factual proof.
 * Copy assembles complete approved fact phrases; numeric clauses preserve one entire source fact.
 * Do not apply this changing policy to already committed delivery bytes or development fixtures.
 */
export function validateLiveListingGrounding(listing: Listing, productFacts: readonly string[]): Listing {
  if (!productFacts.length || productFacts.some(fact => typeof fact !== 'string' || !fact.trim())) {
    throw new HttpError(502, 'AI listing requires explicit agreed product facts');
  }
  const factWords = productFacts.map(words);
  const vocabulary = new Set(factWords.flat());
  const numericFacts = new Set(productFacts.filter(fact => /\p{N}/u.test(fact)).map(normalizedClause));
  for (const field of [listing.title, listing.description, ...listing.bullets]) {
    const copyWords = words(field);
    if (copyWords.some(word => !vocabulary.has(word) && !CONNECTORS.has(word))) {
      throw new HttpError(502, 'AI listing introduced content outside the agreed product facts');
    }
    const covered = copyWords.map(word => CONNECTORS.has(word));
    for (const fact of factWords) {
      if (!fact.length) continue;
      for (let start = 0; start <= copyWords.length - fact.length; start++) {
        if (fact.every((word, offset) => copyWords[start + offset] === word)) {
          for (let offset = 0; offset < fact.length; offset++) covered[start + offset] = true;
        }
      }
    }
    if (covered.some(value => !value)) {
      throw new HttpError(502, 'AI listing changed an agreed product fact phrase or attribute association');
    }
    for (const clause of clauses(field)) {
      if (/\p{N}/u.test(clause) && !numericFacts.has(clause)) {
        throw new HttpError(502, 'AI listing changed a measurement fact or associated its quantity with another subject');
      }
    }
  }
  return listing;
}
