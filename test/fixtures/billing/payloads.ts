// Lemon Squeezy webhook bodies in the documented shape (docs.lemonsqueezy.com: webhook requests, the
// order, subscription and subscription-invoice objects), trimmed to realistic fields.
export const VARIANTS = { subscription: '200001', creditPack: '200002', other: '299999' } as const;

export function orderEvent(input: {
  event?: 'order_created' | 'order_refunded';
  orderId?: number;
  userId?: string | null;
  variantId?: string;
  status?: string;
  refunded?: boolean;
  refundedAmount?: number;
  total?: number;
  testMode?: boolean;
}): Record<string, unknown> {
  const total = input.total ?? 200;
  return {
    meta: { event_name: input.event ?? 'order_created', ...(input.userId === null ? {} : { custom_data: { user_id: input.userId } }) },
    data: {
      type: 'orders',
      id: String(input.orderId ?? 5001),
      attributes: {
        store_id: 100001,
        identifier: '104e18a2-d755-4d4b-80c4-a6c1dcbe1c10',
        order_number: 1,
        user_name: 'Test Learner',
        user_email: 'learner@example.com',
        currency: 'USD',
        subtotal: total,
        total,
        status: input.status ?? 'paid',
        refunded: input.refunded ?? false,
        refunded_amount: input.refundedAmount ?? 0,
        test_mode: input.testMode ?? true,
        first_order_item: { id: 1, order_id: input.orderId ?? 5001, variant_id: Number(input.variantId ?? VARIANTS.creditPack), price: 200, test_mode: input.testMode ?? true },
        created_at: '2026-10-22T10:00:00.000000Z',
        updated_at: '2026-10-22T10:00:00.000000Z',
      },
    },
  };
}

export function subscriptionEvent(input: {
  event?: string;
  subscriptionId?: number;
  userId?: string;
  variantId?: string;
  status?: string;
  renewsAt?: string | null;
  endsAt?: string | null;
  updatedAt?: string;
  testMode?: boolean;
}): Record<string, unknown> {
  return {
    meta: { event_name: input.event ?? 'subscription_created', custom_data: { user_id: input.userId } },
    data: {
      type: 'subscriptions',
      id: String(input.subscriptionId ?? 7001),
      attributes: {
        store_id: 100001,
        order_id: 5002,
        variant_id: Number(input.variantId ?? VARIANTS.subscription),
        user_email: 'learner@example.com',
        status: input.status ?? 'active',
        cancelled: input.status === 'cancelled',
        renews_at: input.renewsAt === undefined ? '2099-11-22T10:00:00.000000Z' : input.renewsAt,
        ends_at: input.endsAt ?? null,
        trial_ends_at: null,
        test_mode: input.testMode ?? true,
        created_at: '2026-10-22T10:00:00.000000Z',
        updated_at: input.updatedAt ?? '2026-10-22T10:00:00.000000Z',
      },
    },
  };
}

export function invoiceRefundEvent(input: { subscriptionId?: number; refunded?: boolean; testMode?: boolean }): Record<string, unknown> {
  return {
    meta: { event_name: 'subscription_payment_refunded' },
    data: {
      type: 'subscription-invoices',
      id: '9001',
      attributes: { subscription_id: input.subscriptionId ?? 7001, billing_reason: 'renewal', status: 'refunded', refunded: input.refunded ?? true, total: 999, refunded_amount: 999, test_mode: input.testMode ?? true },
    },
  };
}
