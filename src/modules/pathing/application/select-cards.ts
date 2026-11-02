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

/** Concepts about the material rather than the topic (check (c) calibration: "Installation", "API Reference"). */
const META_CONCEPTS = [
  'installation',
  'install',
  'setup',
  'set up',
  'getting started',
  'api reference',
  'reference',
  'documentation',
  'docs',
  'course overview',
  'overview',
  'introduction',
  'intro',
  'interview prep',
  'interview preparation',
  'interview questions',
  'faq',
  'resources',
  'conclusion',
  'summary',
];

/** Too advanced to lead a novice-band path (check (c): "Classes" topped a novice Python list). */
const NOVICE_EXCLUDED = ['class', 'classes', 'object oriented programming', 'object-oriented programming', 'oop', 'inheritance', 'polymorphism', 'encapsulation'];

/** A concept must be taught by at least this many cards to count as core. */
export const MIN_CONCEPT_CARDS = 2;
/** Below this many shared concepts, single-card concepts fill the list (most common first). */
export const MIN_CORE_CONCEPTS = 4;

/**
 * The concepts the pool's own cards teach, most common first (the designer covers these in order), built
 * from the cards only, never from eval references or the topic description the references were drafted
 * from. Denoised (lead, 2 Nov 2026): only cards of the path's own stages count, a concept needs at least
 * MIN_CONCEPT_CARDS cards (single-card ones fill up to MIN_CORE_CONCEPTS), meta terms are dropped, and
 * OOP terms are dropped for a novice-band path.
 */
export function coreConcepts(cards: ServedCard[], options: { stages: readonly string[]; target: string }, limit = 12): string[] {
  const banned = new Set([...META_CONCEPTS, ...(options.target === 'novice' ? NOVICE_EXCLUDED : [])].map(normaliseConcept));
  const counts = new Map<string, { name: string; n: number; first: number }>();
  cards
    .filter((card) => options.stages.includes(card.stage))
    .forEach((card, i) => {
      for (const concept of new Set(card.concepts.map((c) => c.name))) {
        const key = normaliseConcept(concept);
        if (!key || banned.has(key)) continue;
        const entry = counts.get(key) ?? { name: concept, n: 0, first: i };
        entry.n += 1;
        counts.set(key, entry);
      }
    });
  const ranked = [...counts.values()].sort((a, b) => b.n - a.n || a.first - b.first);
  const core = ranked.filter((e) => e.n >= MIN_CONCEPT_CARDS);
  // Card concepts are specific and rarely repeat, so a pool may have few shared ones: fill up to
  // MIN_CORE_CONCEPTS from single-card concepts (still stage-filtered and stop-listed) rather than
  // leaving the designer with no list (check (c) preview: 4 of 7 dev cases had none).
  const filled = core.length >= MIN_CORE_CONCEPTS ? core : [...core, ...ranked.filter((e) => e.n < MIN_CONCEPT_CARDS).slice(0, MIN_CORE_CONCEPTS - core.length)];
  return filled.slice(0, limit).map((e) => e.name);
}
