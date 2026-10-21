/** How a resolution was decided; `create_new` is the learner's explicit "none of these" (contract 0.5.0). */
export type ResolveMethod = 'exact' | 'vector' | 'name_fallback' | 'create_new';

/** Published after a resolution commits (PRD-API §4 catalog event). */
export class TopicResolved {
  readonly type = 'TopicResolved';
  readonly occurredAt = new Date();

  constructor(
    readonly userId: string,
    readonly status: 'matched' | 'choices' | 'created',
    /** The matched or created topic; null for choices. */
    readonly topicId: string | null,
    /** True when a created topic still needs a reviewer (normaliser unavailable). */
    readonly needsReview: boolean,
    readonly method: ResolveMethod,
    /**
     * Best and runner-up similarity seen (cosine for `vector`, trigram for `name_fallback`; 1 for `exact`,
     * null for `create_new`), so thresholds can be re-tuned from real traffic.
     */
    readonly topSimilarity: number | null,
    readonly secondSimilarity: number | null,
  ) {}
}
