/** The learner already created today's maximum of new topics (429 with Retry-After). */
export class TopicCreateLimitError extends Error {
  override name = 'TopicCreateLimitError';

  constructor(readonly retryAfterSeconds: number) {
    super('Daily limit for new topics reached');
  }
}

/** Nothing resolvable is left once the text is normalised (only punctuation, for example). */
export class TopicTextInvalidError extends Error {
  override name = 'TopicTextInvalidError';
}
