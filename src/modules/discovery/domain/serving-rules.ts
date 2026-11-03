import { type Stage, STAGES } from './types';

/**
 * Which analysed cards a pool serves (A8 follow-up, user 3 Nov 2026). Free code rules, applied when
 * cards are read for a path; nothing is deleted, so a rule change takes effect on the next read.
 * - relevance: the analysis scored the card under MIN_SERVED_RELEVANCE.
 * - off_map: under STRONG_RELEVANCE and teaching none of the topic's map concepts at the pool's stage
 *   or either neighbour (skipped when the topic has no map).
 * - stage: the card's own stage is 2 or more below the pool's (an overview in a later pool).
 * - page_kind: an index, course enrolment or catalogue page rather than material (pageKind).
 * A pool left under MIN_SERVED_CARDS keeps its best dropped cards by relevance (never page kinds) and
 * is flagged.
 */
export const MIN_SERVED_RELEVANCE = 70;
export const STRONG_RELEVANCE = 85;
export const MIN_SERVED_CARDS = 6;

export type ServeDrop = 'relevance' | 'off_map' | 'stage' | 'page_kind';
export type PageKind = 'index' | 'course_landing' | 'catalogue';

export interface ServableCard {
  title: string;
  url: string;
  stage: Stage;
  quality: { relevance: number };
  concepts: { name: string }[];
}

/** Section-root pages: a docs tree's index, a bare reference or tutorials root. */
const INDEX_PATH = /^\/(?:docs?|documentation)?\/?(?:reference|references|tutorials?|docs?|documentation|api-reference(?:\/v[\d.]+)?)?\/?$/i;
const INDEX_TITLE = /^(?:(?:[\w.+#]+ ){0,3}(?:api )?references?(?: docs| documentation)?|tutorials?|documentation|docs|our documentation|[\w .+#]{1,30} - reference documentation)$/i;
/** Course enrolment pages: marketing for a course, not its material. */
const COURSE_LANDING = [/(^|\.)coursera\.org$/, /(^|\.)alison\.com$/, /(^|\.)udemy\.com$/, /(^|\.)edx\.org$/, /(^|\.)futurelearn\.com$/];
const COURSE_PATH = /^\/(?:learn|course|courses|specializations?|professional-certificates)\//i;
/** Catalogue entries that describe a book or course and link out to it. */
const CATALOGUE_TITLE = /\s[-|–]\s(?:Open Textbook Library|Open Tech Book)$/i;
const CATALOGUE_PATH = /^\/opentextbooks\/textbooks\//i;

export function pageKind(title: string, url: string): PageKind | null {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  const host = parsed.hostname.toLowerCase();
  const path = parsed.pathname.replace(/\/+$/, '') || '/';
  if (COURSE_LANDING.some((re) => re.test(host)) && COURSE_PATH.test(`${path}/`)) return 'course_landing';
  if (CATALOGUE_TITLE.test(title.trim()) || CATALOGUE_PATH.test(path)) return 'catalogue';
  if (INDEX_TITLE.test(title.trim()) && (INDEX_PATH.test(path) || /\/(?:reference|tutorials|doc|docs)$/i.test(path))) return 'index';
  return null;
}

/** Null when the card is served; otherwise why it is not. `mapNames` null means the topic has no map. */
export function serveDrop(card: ServableCard, poolStage: Stage, mapNames: readonly string[] | null, matches: (concept: string, names: readonly string[]) => boolean): ServeDrop | null {
  if (pageKind(card.title, card.url)) return 'page_kind';
  if (STAGES.indexOf(poolStage) - STAGES.indexOf(card.stage) >= 2) return 'stage';
  if (card.quality.relevance < MIN_SERVED_RELEVANCE) return 'relevance';
  if (mapNames && card.quality.relevance < STRONG_RELEVANCE && !card.concepts.some((c) => matches(c.name, mapNames))) return 'off_map';
  return null;
}

/** A learner's preferred formats need at least this many usable served cards (pathing's MIN_FORMAT_CARDS). */
export const MIN_PREFERRED_CARDS = 3;

/**
 * The learner's preference, from the caller (pathing): which served cards it can actually use for this
 * learner (format, language, length), so discovery needs no pathing rules of its own.
 */
export interface ServePreference<C> {
  usable: (card: C) => boolean;
}

export function servedCards<C extends ServableCard>(
  cards: C[],
  poolStage: Stage,
  mapNames: readonly string[] | null,
  matches: (concept: string, names: readonly string[]) => boolean,
  prefer?: ServePreference<C>,
): { cards: C[]; dropped: Record<ServeDrop, number>; refilled: number; formatRefilled: number; flagged: boolean } {
  const dropped: Record<ServeDrop, number> = { relevance: 0, off_map: 0, stage: 0, page_kind: 0 };
  const kept = new Set<C>();
  const spare: C[] = [];
  const offMap: C[] = [];
  for (const card of cards) {
    const why = serveDrop(card, poolStage, mapNames, matches);
    if (!why) kept.add(card);
    else {
      dropped[why] += 1;
      if (why !== 'page_kind') spare.push(card);
      if (why === 'off_map') offMap.push(card);
    }
  }
  const byRelevance = (list: C[]): C[] => [...list].sort((a, b) => b.quality.relevance - a.quality.relevance);
  let refilled = 0;
  let formatRefilled = 0;
  // The learner's format first (lead, 4 Nov 2026): too few usable cards in it, and pathing would fall back
  // to every format. Only off-map holds may return: never page kinds, stage 2+ below, or relevance < 70.
  if (prefer) {
    const usable = [...kept].filter(prefer.usable).length;
    for (const card of byRelevance(offMap).filter(prefer.usable).slice(0, Math.max(0, MIN_PREFERRED_CARDS - usable))) {
      kept.add(card);
      formatRefilled += 1;
    }
  }
  // Then the served minimum, from the best held cards (never page kinds).
  if (kept.size < MIN_SERVED_CARDS && cards.length > 0) {
    for (const card of byRelevance(spare.filter((c) => !kept.has(c))).slice(0, MIN_SERVED_CARDS - kept.size)) {
      kept.add(card);
      refilled += 1;
    }
  }
  // Keep the pool's order: returned cards stay where they were.
  return { cards: cards.filter((c) => kept.has(c)), dropped, refilled, formatRefilled, flagged: refilled + formatRefilled > 0 };
}
