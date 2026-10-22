/**
 * Contract 0.9.0 `related`: catalog topics offered beside a newly created one. Suggestions stay in the
 * learner's domain (user requirement, 22 Oct 2026: "Indonesian language" must not suggest Java), and
 * must reach RELATED_FLOOR. Tuned on the golden set only: a topic in another domain typically scores
 * 0.60 against an unrelated phrase (median of each phrase's best cross-domain topic), so anything lower
 * is weaker than noise.
 */
export const RELATED_FLOOR = 0.6;
/**
 * When the domain comes only from the nearest catalog topic (no normaliser domain), each suggestion must
 * reach this instead: a wrong-domain suggestion is worse than none (user requirement, 22 Oct 2026).
 */
export const RELATED_FALLBACK_FLOOR = 0.65;
export const MAX_RELATED = 3;

export type Domain = 'software' | 'stem' | 'non_technical';

export interface Neighbour {
  topicId: string;
  similarity: number;
  domain: Domain | null;
}

/**
 * Candidates for `related`, nearest first: in `domain` at RELATED_FLOOR or above, or, when the topic's
 * domain is unknown, in the nearest neighbour's domain at RELATED_FALLBACK_FLOOR or above; never the
 * created topic itself. The caller prefers topics with a bank.
 */
export function relatedCandidates(neighbours: readonly Neighbour[], domain: Domain | null, excludeTopicId: string): Neighbour[] {
  const sorted = [...neighbours]
    .filter((n) => n.topicId !== excludeTopicId)
    .sort((a, b) => b.similarity - a.similarity || a.topicId.localeCompare(b.topicId));
  const wanted = domain ?? sorted[0]?.domain ?? null;
  const floor = domain ? RELATED_FLOOR : RELATED_FALLBACK_FLOOR;
  return sorted.filter((n) => n.similarity >= floor && (wanted === null || n.domain === wanted));
}

/** The final pick: topics with a diagnostic bank first, then by similarity; at most 3. */
export function pickRelated(candidates: readonly Neighbour[], withBank: ReadonlySet<string>): Neighbour[] {
  return [...candidates]
    .sort((a, b) => Number(withBank.has(b.topicId)) - Number(withBank.has(a.topicId)) || b.similarity - a.similarity)
    .slice(0, MAX_RELATED);
}
