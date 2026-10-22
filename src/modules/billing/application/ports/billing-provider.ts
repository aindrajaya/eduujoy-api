export const BILLING_PROVIDER = Symbol('BillingProvider');

/** The payment provider (master PRD risk table: keep Lemon Squeezy behind one adapter). */
export interface BillingProvider {
  /** A hosted checkout for one variant, carrying our user id back in the webhook's custom data. */
  createCheckout(input: { storeId: string; variantId: string; userId: string; testMode: boolean; redirectUrl: string; quantity: number }): Promise<{ url: string }>;
  /** Line items of an order; webhooks carry no quantity, so credit packs are counted from these. */
  listOrderItems(orderId: string): Promise<{ variantId: string; quantity: number }[]>;
}
