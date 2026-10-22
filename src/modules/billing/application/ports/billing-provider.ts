export const BILLING_PROVIDER = Symbol('BillingProvider');

/** The provider answered with an HTTP error. 401, 403 and 404 won't change on a retry. */
export class BillingProviderHttpError extends Error {
  override name = 'BillingProviderHttpError';

  constructor(readonly status: number) {
    // Status only: response bodies can echo request data, and the key must never reach a log.
    super(`Lemon Squeezy API returned HTTP ${status}`);
  }

  get permanent(): boolean {
    return this.status === 401 || this.status === 403 || this.status === 404;
  }
}

/** The payment provider (master PRD risk table: keep Lemon Squeezy behind one adapter). */
export interface BillingProvider {
  /** A hosted checkout for one variant, carrying our user id back in the webhook's custom data. */
  createCheckout(input: { storeId: string; variantId: string; userId: string; testMode: boolean; redirectUrl: string; quantity: number }): Promise<{ url: string }>;
  /** Line items of an order; webhooks carry no quantity, so credit packs are counted from these. */
  listOrderItems(orderId: string): Promise<{ variantId: string; quantity: number }[]>;
  /**
   * Whether the API key is a test-mode key, or null when unknown. Test-mode keys "interact with test
   * mode store data only" (docs.lemonsqueezy.com/help/getting-started/test-mode).
   */
  apiKeyTestMode(): Promise<boolean | null>;
}
