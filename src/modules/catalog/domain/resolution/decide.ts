import { CHOICE_THRESHOLD, MATCH_THRESHOLD, MAX_CHOICES } from './thresholds';

export interface Candidate {
  topicId: string;
  /** Cosine similarity in [0, 1]. */
  similarity: number;
}

export type Decision =
  | { kind: 'matched'; topicId: string; similarity: number }
  | { kind: 'choices'; choices: Candidate[] }
  | { kind: 'create' };

/**
 * FR-02: at or above MATCH_THRESHOLD auto-matches the nearest topic; from CHOICE_THRESHOLD up to it offers
 * up to 3 choices, nearest first; anything lower creates a new topic.
 */
export function decide(candidates: Candidate[]): Decision {
  const sorted = [...candidates].sort((a, b) => b.similarity - a.similarity || a.topicId.localeCompare(b.topicId));
  const top = sorted[0];
  if (top && top.similarity >= MATCH_THRESHOLD) return { kind: 'matched', topicId: top.topicId, similarity: top.similarity };
  const choices = sorted.filter((c) => c.similarity >= CHOICE_THRESHOLD).slice(0, MAX_CHOICES);
  return choices.length > 0 ? { kind: 'choices', choices } : { kind: 'create' };
}

/** Clamp a pgvector cosine similarity (1 - distance) into [0, 1] for the contract. */
export function clampSimilarity(value: number): number {
  return Math.min(1, Math.max(0, Math.round(value * 10_000) / 10_000));
}
