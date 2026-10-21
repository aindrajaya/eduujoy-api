/** Published after a resolution commits (PRD-API §4 catalog event). */
export class TopicResolved {
  readonly type = 'TopicResolved';
  readonly occurredAt = new Date();

  constructor(
    readonly userId: string,
    readonly status: 'matched' | 'choices' | 'created',
    /** The matched or created topic; null for choices. */
    readonly topicId: string | null,
    /** True when a created topic still needs a reviewer (normaliser unavailable or no embedding). */
    readonly needsReview: boolean,
  ) {}
}
