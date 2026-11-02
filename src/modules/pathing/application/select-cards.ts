import { type ServedCard } from '../../discovery/application/ports/card.reader';
import { normaliseConcept } from '../domain';

export type ResourceFormat = 'video' | 'text' | 'papers';

/** The diagnostic's formats as resource types (contract ResourceFormat). */
const FORMAT_TYPES: Record<ResourceFormat, readonly ServedCard['type'][]> = {
  video: ['youtube'],
  text: ['article', 'official_doc', 'related'],
  papers: ['paper'],
};

/** A preferred format becomes a hard filter only when the pool has at least this many matching cards. */
export const MIN_FORMAT_CARDS = 3;
/** Docs and related pages shorter than this are stubs (lead, 3 Nov 2026), not a step's material. */
export const MIN_STUB_READING_MIN = 3;
const STUB_TYPES: readonly ServedCard['type'][] = ['official_doc', 'related'];

export interface CardSelection {
  cards: ServedCard[];
  /** The learner's formats could not be honoured: too few matching cards, so every format was kept. */
  formatFallback: boolean;
  /** Cards dropped for not being in the path's language. */
  droppedForLanguage: number;
  /** Resources too long for one step that cannot be split: texts, and videos without timed chapters. */
  droppedTooLong: number;
  /** Docs and related pages under MIN_STUB_READING_MIN minutes. */
  droppedStubs: number;
}

/** A video whose chapters carry times can be cited in parts (actions point at a chapter). */
function hasTimedChapters(card: ServedCard): boolean {
  return card.concepts.some((c) => c.start !== null && c.end !== null);
}

/** Fits a step of at most `stepMax` minutes, whole or by its timed chapters. */
function fitsStep(card: ServedCard, stepMax: number): boolean {
  if (card.type === 'youtube') return card.durationMin === null || card.durationMin <= stepMax || hasTimedChapters(card);
  return card.readingMin === null || card.readingMin <= stepMax;
}

/**
 * The cards a path may use (v3, lead 3 Nov 2026): no stubs (docs and related pages under
 * MIN_STUB_READING_MIN minutes); nothing longer than one step (`stepMax`, stepMaxMinutes) unless it is a
 * video with timed chapters to cite in parts (texts are cited whole); only cards in the path's language
 * (one setting, default English); then only the learner's preferred formats when at least
 * MIN_FORMAT_CARDS match, otherwise all formats, flagged.
 */
export function selectCards(cards: ServedCard[], options: { language: string; formats: ResourceFormat[]; stepMax: number }): CardSelection {
  const notStub = cards.filter((c) => !(STUB_TYPES.includes(c.type) && c.readingMin !== null && c.readingMin < MIN_STUB_READING_MIN));
  const usable = notStub.filter((c) => fitsStep(c, options.stepMax));
  const inLanguage = usable.filter((c) => c.language.toLowerCase() === options.language.toLowerCase());
  const counts = { droppedForLanguage: usable.length - inLanguage.length, droppedTooLong: notStub.length - usable.length, droppedStubs: cards.length - notStub.length };
  if (options.formats.length === 0) return { cards: inLanguage, formatFallback: false, ...counts };
  const wanted = new Set(options.formats.flatMap((f) => FORMAT_TYPES[f]));
  const matching = inLanguage.filter((c) => wanted.has(c.type));
  return matching.length >= MIN_FORMAT_CARDS ? { cards: matching, formatFallback: false, ...counts } : { cards: inLanguage, formatFallback: true, ...counts };
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
