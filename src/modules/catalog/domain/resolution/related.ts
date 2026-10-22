/**
 * Contract 0.9.0 `related`: catalog topics offered beside a newly created one. Suggestions stay in the
 * learner's domain (user requirement, 22 Oct 2026: "Indonesian language" must not suggest Java), and
 * must reach RELATED_FLOOR. Tuned on the golden set only: a topic in another domain typically scores
 * 0.60 against an unrelated phrase (median of each phrase's best cross-domain topic), so anything lower
 * is weaker than noise.
 */
export const RELATED_FLOOR = 0.6;
export const MAX_RELATED = 3;

export type Domain = 'software' | 'stem' | 'non_technical';

export interface Neighbour {
  topicId: string;
  similarity: number;
  domain: Domain | null;
}

/**
 * Candidates for `related`, nearest first: in `domain` (or, when it is unknown, the nearest neighbour's
 * domain), at or above the floor, never the created topic itself. The caller prefers topics with a bank.
 */
export function relatedCandidates(neighbours: readonly Neighbour[], domain: Domain | null, excludeTopicId: string): Neighbour[] {
  const sorted = [...neighbours].sort((a, b) => b.similarity - a.similarity || a.topicId.localeCompare(b.topicId));
  const wanted = domain ?? sorted.find((n) => n.topicId !== excludeTopicId)?.domain ?? null;
  return sorted.filter((n) => n.topicId !== excludeTopicId && n.similarity >= RELATED_FLOOR && (wanted === null || n.domain === wanted));
}

/** The final pick: topics with a diagnostic bank first, then by similarity; at most 3. */
export function pickRelated(candidates: readonly Neighbour[], withBank: ReadonlySet<string>): Neighbour[] {
  return [...candidates]
    .sort((a, b) => Number(withBank.has(b.topicId)) - Number(withBank.has(a.topicId)) || b.similarity - a.similarity)
    .slice(0, MAX_RELATED);
}
