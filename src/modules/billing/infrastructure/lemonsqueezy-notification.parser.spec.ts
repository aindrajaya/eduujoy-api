import { invoiceRefundEvent, orderEvent, subscriptionEvent, VARIANTS } from '../../../../test/fixtures/billing/payloads';
import { LemonSqueezyNotificationParser } from './lemonsqueezy-notification.parser';

const USER = '0b1c6a1e-7f43-4c3c-9d39-5f2f6a1f0a11';
const parser = new LemonSqueezyNotificationParser();

describe('LemonSqueezyNotificationParser', () => {
  it('reads orders: id, variant, status, refund amounts, test mode and our user id', () => {
    expect(parser.parse(orderEvent({ userId: USER, orderId: 42, refundedAmount: 50, total: 400 }))).toEqual({
      kind: 'order',
      event: 'order_created',
      orderId: '42',
      userId: USER,
      variantId: VARIANTS.creditPack,
      status: 'paid',
      refunded: false,
      refundedAmount: 50,
      total: 400,
      testMode: true,
    });
  });

  it('reads subscriptions with dates', () => {
    expect(parser.parse(subscriptionEvent({ userId: USER, status: 'cancelled', endsAt: '2026-11-01T00:00:00.000000Z' }))).toMatchObject({
      kind: 'subscription',
      subscriptionId: '7001',
      variantId: VARIANTS.subscription,
      status: 'cancelled',
      endsAt: new Date('2026-11-01T00:00:00Z'),
      updatedAt: new Date('2026-10-22T10:00:00Z'),
    });
  });

  it('reads subscription payment refunds from the invoice', () => {
    expect(parser.parse(invoiceRefundEvent({}))).toEqual({ kind: 'subscription_refund', subscriptionId: '7001', refunded: true, testMode: true });
  });

  it('drops a user id that is not a UUID', () => {
    expect(parser.parse(orderEvent({ userId: "1' or '1'='1" }))).toMatchObject({ userId: null });
    expect(parser.parse(orderEvent({ userId: null }))).toMatchObject({ userId: null });
  });

  it('passes other events through as ignored, and rejects malformed payloads', () => {
    expect(parser.parse({ meta: { event_name: 'license_key_created' }, data: { type: 'license-keys', attributes: { test_mode: false } } })).toEqual({
      kind: 'ignored',
      event: 'license_key_created',
      testMode: false,
    });
    expect(parser.parse({ meta: {}, data: {} })).toBeNull();
    const broken = orderEvent({});
    (broken['data'] as { attributes: Record<string, unknown> }).attributes['total'] = 'lots';
    expect(parser.parse(broken)).toBeNull();
    expect(parser.parse(subscriptionEvent({ status: 'weird' }))).toBeNull();
  });
});
