/** Plan allowance and credits are both used up (402 QUOTA_EXCEEDED on POST /v1/paths, contract QuotaExceeded). */
export class QuotaExceededError extends Error {
  override name = 'QuotaExceededError';

  constructor(
    readonly monthlyPaths: number,
    readonly periodEnd: Date,
  ) {
    super('Path quota exceeded');
  }
}

/** The provider failed, or returned a checkout URL that is not a Lemon Squeezy https URL (503, contract 0.6.0). */
export class CheckoutUnavailableError extends Error {
  override name = 'CheckoutUnavailableError';
  readonly retryAfterSeconds = 30;
}

/** A subscription checkout while a subscription is active (409 CONFLICT, contract 0.6.0); credit packs are fine. */
export class SubscriptionActiveError extends Error {
  override name = 'SubscriptionActiveError';
}
