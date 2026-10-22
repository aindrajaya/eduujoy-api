import { Injectable } from '@nestjs/common';
import { z } from 'zod';
import { type BillingNotification, type NotificationParser } from '../application/ports/billing-notification';

// Shapes from docs.lemonsqueezy.com (webhook requests, the order, subscription and subscription-invoice
// objects). Unknown fields pass through; only what billing acts on is validated.
const providerId = z.union([z.string().regex(/^\d{1,20}$/), z.number().int().nonnegative()]).transform(String);
const isoDate = z.iso.datetime({ offset: true }).transform((value) => new Date(value));
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const meta = z.object({
  event_name: z.string().min(1).max(64),
  custom_data: z.object({ user_id: z.unknown().optional() }).loose().nullish(),
});

const order = z.object({
  type: z.literal('orders'),
  id: providerId,
  attributes: z.object({
    status: z.string().max(32),
    refunded: z.boolean(),
    refunded_amount: z.number().int().nonnegative(),
    total: z.number().int().nonnegative(),
    test_mode: z.boolean(),
    first_order_item: z.object({ variant_id: providerId }).loose(),
  }),
});

const subscription = z.object({
  type: z.literal('subscriptions'),
  id: providerId,
  attributes: z.object({
    order_id: providerId,
    variant_id: providerId,
    status: z.enum(['on_trial', 'active', 'paused', 'past_due', 'unpaid', 'cancelled', 'expired']),
    renews_at: isoDate.nullable(),
    ends_at: isoDate.nullable(),
    updated_at: isoDate,
    test_mode: z.boolean(),
  }),
});

const invoice = z.object({
  type: z.literal('subscription-invoices'),
  id: providerId,
  attributes: z.object({ subscription_id: providerId, refunded: z.boolean(), test_mode: z.boolean() }),
});

const ORDER_EVENTS = new Set(['order_created', 'order_refunded']);
const SUBSCRIPTION_EVENTS = new Set([
  'subscription_created',
  'subscription_updated',
  'subscription_cancelled',
  'subscription_resumed',
  'subscription_expired',
  'subscription_paused',
  'subscription_unpaused',
]);

@Injectable()
export class LemonSqueezyNotificationParser implements NotificationParser {
  parse(payload: unknown): BillingNotification | null {
    const head = z.object({ meta, data: z.object({ type: z.string() }).loose() }).safeParse(payload);
    if (!head.success) return null;
    const event = head.data.meta.event_name;
    const rawUser = head.data.meta.custom_data?.user_id;
    const userId = typeof rawUser === 'string' && UUID.test(rawUser) ? rawUser.toLowerCase() : null;
    const data = (payload as { data: unknown }).data;

    if (ORDER_EVENTS.has(event)) {
      const o = order.safeParse(data);
      if (!o.success) return null;
      const a = o.data.attributes;
      return {
        kind: 'order',
        event: event as 'order_created' | 'order_refunded',
        orderId: o.data.id,
        userId,
        variantId: a.first_order_item.variant_id,
        status: a.status,
        refunded: a.refunded,
        refundedAmount: a.refunded_amount,
        total: a.total,
        testMode: a.test_mode,
      };
    }
    if (SUBSCRIPTION_EVENTS.has(event)) {
      const s = subscription.safeParse(data);
      if (!s.success) return null;
      const a = s.data.attributes;
      return {
        kind: 'subscription',
        event,
        subscriptionId: s.data.id,
        orderId: a.order_id,
        userId,
        variantId: a.variant_id,
        status: a.status,
        renewsAt: a.renews_at,
        endsAt: a.ends_at,
        updatedAt: a.updated_at,
        testMode: a.test_mode,
      };
    }
    if (event === 'subscription_payment_refunded') {
      const i = invoice.safeParse(data);
      if (!i.success) return null;
      return { kind: 'subscription_refund', subscriptionId: i.data.attributes.subscription_id, refunded: i.data.attributes.refunded, testMode: i.data.attributes.test_mode };
    }
    const testMode = (data as { attributes?: { test_mode?: unknown } }).attributes?.test_mode;
    return { kind: 'ignored', event, testMode: typeof testMode === 'boolean' ? testMode : null };
  }
}
