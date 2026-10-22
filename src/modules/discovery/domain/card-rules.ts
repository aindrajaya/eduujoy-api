import { type CardStatus } from './types';

/** FR-11: resources scoring under 60 are dropped. */
export const QUALITY_FLOOR = 60;
/** Master PRD §12: tags with confidence under 0.7 go to the review queue and are not served. */
export const CONFIDENCE_FLOOR = 0.7;
/** PRD-API §9: the nearest card in the same topic at cosine ≥ 0.95 is a duplicate. */
export const DUPLICATE_SIMILARITY = 0.95;
/** PRD-API §10: ResourceCards are cached 30 days. */
export const CARD_TTL_DAYS = 30;

export interface Quality {
  relevance: number;
  accuracySignals: number;
  recency: number;
  teaching: number;
}

export interface Concept {
  name: string;
  /** `mm:ss` or `h:mm:ss`, videos only. */
  start?: string | null;
  end?: string | null;
}

/** The overall score: the mean of the four sub-scores (user decision, 22 Oct 2026), one decimal. */
export function qualityScore(q: Quality): number {
  return Math.round(((q.relevance + q.accuracySignals + q.recency + q.teaching) / 4) * 10) / 10;
}

/** Seconds from `ss`, `mm:ss` or `h:mm:ss`; null when malformed. */
export function timestampSeconds(value: string): number | null {
  if (!/^\d{1,3}(:\d{1,2}){0,2}$/.test(value)) return null;
  const parts = value.split(':').map(Number);
  if (parts.slice(1).some((p) => p >= 60)) return null;
  return parts.reduce((total, part) => total * 60 + part, 0);
}

/** Master PRD §12: every concept range must fall inside the video. Returns the first bad concept, if any. */
export function badConceptRange(concepts: Concept[], durationMin: number | null): string | null {
  for (const concept of concepts) {
    if (concept.start == null && concept.end == null) continue;
    const start = concept.start == null ? null : timestampSeconds(concept.start);
    const end = concept.end == null ? null : timestampSeconds(concept.end);
    if (start === null || end === null || end < start) return concept.name;
    // duration_min is rounded up from the real length, so allow up to that minute.
    if (durationMin !== null && end > durationMin * 60) return concept.name;
  }
  return null;
}

export interface CardVerdict {
  status: Extract<CardStatus, 'served' | 'review' | 'dropped'>;
  reason: string | null;
}

/** What happens to a freshly analysed card, before dedupe. */
export function judgeCard(input: { quality: Quality; confidence: number; concepts: Concept[]; durationMin: number | null; isVideo: boolean }): CardVerdict {
  const score = qualityScore(input.quality);
  if (score < QUALITY_FLOOR) return { status: 'dropped', reason: `quality ${score} < ${QUALITY_FLOOR}` };
  if (input.confidence < CONFIDENCE_FLOOR) return { status: 'review', reason: `confidence ${input.confidence} < ${CONFIDENCE_FLOOR}` };
  if (input.isVideo) {
    const bad = badConceptRange(input.concepts, input.durationMin);
    if (bad !== null) return { status: 'review', reason: `timestamp out of range: ${bad}` };
  }
  return { status: 'served', reason: null };
}

/** PRD-API §9: what a card is embedded from (never raw transcripts). */
export function embeddingText(card: { title: string; keyTakeaways: string[]; concepts: Concept[] }): string {
  return [card.title, ...card.keyTakeaways, ...card.concepts.map((c) => c.name)].join('\n');
}
