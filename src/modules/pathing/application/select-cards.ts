import { type ServedCard } from '../../discovery/application/ports/card.reader';
import { MAX_STEP_MINUTES, normaliseConcept } from '../domain';

export type ResourceFormat = 'video' | 'text' | 'papers';

/** The diagnostic's formats as resource types (contract ResourceFormat). */
const FORMAT_TYPES: Record<ResourceFormat, readonly ServedCard['type'][]> = {
  video: ['youtube'],
  text: ['article', 'official_doc', 'related'],
  papers: ['paper'],
};

/** A preferred format becomes a hard filter only when the pool has at least this many matching cards. */
export const MIN_FORMAT_CARDS = 3;

export interface CardSelection {
  cards: ServedCard[];
  /** The learner's formats could not be honoured: too few matching cards, so every format was kept. */
  formatFallback: boolean;
  /** Cards dropped for not being in the path's language. */
  droppedForLanguage: number;
  /** Texts too long for any step (over MAX_STEP_MINUTES of reading). */
  droppedTooLong: number;
}

/**
 * The cards a path may use (v2, after check (c)): only those in the path's language (one setting,
 * default English, until the learner's language is a product decision), then only the learner's
 * preferred formats when at least MIN_FORMAT_CARDS match; otherwise all formats, flagged.
 */
export function selectCards(cards: ServedCard[], options: { language: string; formats: ResourceFormat[] }): CardSelection {
  // A text no step can hold (more than MAX_STEP_MINUTES of reading, and texts can't be cited in part) is left out.
  const usable = cards.filter((c) => c.type === 'youtube' || c.readingMin === null || c.readingMin <= MAX_STEP_MINUTES);
  const inLanguage = usable.filter((c) => c.language.toLowerCase() === options.language.toLowerCase());
  if (options.formats.length === 0) return { cards: inLanguage, formatFallback: false, droppedForLanguage: usable.length - inLanguage.length, droppedTooLong: cards.length - usable.length };
  const wanted = new Set(options.formats.flatMap((f) => FORMAT_TYPES[f]));
  const matching = inLanguage.filter((c) => wanted.has(c.type));
  return matching.length >= MIN_FORMAT_CARDS
    ? { cards: matching, formatFallback: false, droppedForLanguage: usable.length - inLanguage.length, droppedTooLong: cards.length - usable.length }
    : { cards: inLanguage, formatFallback: true, droppedForLanguage: usable.length - inLanguage.length, droppedTooLong: cards.length - usable.length };
}

/**
 * The concepts the pool's own cards teach, most common first (the designer covers these in order).
 * Built from the cards only, never from eval references.
 */
export function coreConcepts(cards: ServedCard[], limit = 12): string[] {
  const counts = new Map<string, { name: string; n: number; first: number }>();
  cards.forEach((card, i) => {
    for (const concept of new Set(card.concepts.map((c) => c.name))) {
      const key = normaliseConcept(concept);
      if (!key) continue;
      const entry = counts.get(key) ?? { name: concept, n: 0, first: i };
      entry.n += 1;
      counts.set(key, entry);
    }
  });
  return [...counts.values()].sort((a, b) => b.n - a.n || a.first - b.first).slice(0, limit).map((e) => e.name);
}
