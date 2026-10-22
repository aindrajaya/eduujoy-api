import { CHOICE_THRESHOLD, MATCH_MARGIN, MATCH_THRESHOLD, MAX_CHOICES } from './thresholds';

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
 * FR-02: at or above MATCH_THRESHOLD, and at least MATCH_MARGIN ahead of the runner-up, auto-matches the
 * nearest topic; otherwise topics from CHOICE_THRESHOLD up are offered as up to 3 choices, nearest first
 * (a top-1 within the margin always has its runner-up above CHOICE_THRESHOLD); lower creates a new topic.
 */
export function decide(candidates: Candidate[]): Decision {
  const sorted = [...candidates].sort((a, b) => b.similarity - a.similarity || a.topicId.localeCompare(b.topicId));
  const [top, runnerUp] = sorted;
  // In ten-thousandths (similarities carry 4 decimals), so 0.70 vs 0.66 counts as a 0.04 gap.
  const clear = !runnerUp || Math.round(((top?.similarity ?? 0) - runnerUp.similarity) * 10_000) >= Math.round(MATCH_MARGIN * 10_000);
  if (top && top.similarity >= MATCH_THRESHOLD && clear) return { kind: 'matched', topicId: top.topicId, similarity: top.similarity };
  const choices = sorted.filter((c) => c.similarity >= CHOICE_THRESHOLD).slice(0, MAX_CHOICES);
  return choices.length > 0 ? { kind: 'choices', choices } : { kind: 'create' };
}

/** Clamp a pgvector cosine similarity (1 - distance) into [0, 1] for the contract. */
export function clampSimilarity(value: number): number {
  return Math.min(1, Math.max(0, Math.round(value * 10_000) / 10_000));
}
