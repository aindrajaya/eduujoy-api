/** Plan allowance and credits are both used up (429 QUOTA_EXCEEDED, contract QuotaExceeded). */
export class QuotaExceededError extends Error {
  override name = 'QuotaExceededError';

  constructor(
    readonly monthlyPaths: number,
    readonly periodEnd: Date,
  ) {
    super('Path quota exceeded');
  }
}

/** The provider returned a checkout URL that is not a Lemon Squeezy https URL. */
export class CheckoutUnavailableError extends Error {
  override name = 'CheckoutUnavailableError';
}
