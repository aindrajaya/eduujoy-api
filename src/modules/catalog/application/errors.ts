/** The learner already created today's maximum of new topics (429 with Retry-After). */
export class TopicCreateLimitError extends Error {
  override name = 'TopicCreateLimitError';

  constructor(readonly retryAfterSeconds: number) {
    super('Daily limit for new topics reached');
  }
}

/** The embedding provider is down and no name or alias is close (503 with Retry-After, contract 0.4.0-v0). */
export class TopicSearchUnavailableError extends Error {
  override name = 'TopicSearchUnavailableError';

  constructor(readonly retryAfterSeconds: number) {
    super('Topic search is briefly unavailable');
  }
}

/** Nothing resolvable is left once the text is normalised (only punctuation, for example). */
export class TopicTextInvalidError extends Error {
  override name = 'TopicTextInvalidError';
}
