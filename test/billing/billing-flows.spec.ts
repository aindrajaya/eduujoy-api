// Billing flows end to end in memory: real parser and use cases, fake repository and provider.
import { createHmac, randomUUID } from 'node:crypto';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { invoiceRefundEvent, orderEvent, subscriptionEvent, VARIANTS } from '../fixtures/billing/payloads';
import { AppConfig } from '../../src/shared/config';
import { type Env } from '../../src/shared/config/env';
import { type Database } from '../../src/shared/db/database';
import { EventBus } from '../../src/shared/events/event-bus';
import { UnitOfWork } from '../../src/shared/events/unit-of-work';
import { type JobQueue } from '../../src/shared/jobs';
import { type EntitlementChanged } from '../../src/modules/billing/domain/events/entitlement-changed.event';
import { LemonSqueezyNotificationParser } from '../../src/modules/billing/infrastructure/lemonsqueezy-notification.parser';
import { FakeBillingProvider, FakeBillingRepository, fakeQuotaRepository } from '../../src/modules/billing/application/billing.fakes';
import { CreateCheckout, isProviderCheckoutUrl } from '../../src/modules/billing/application/create-checkout.usecase';
import { CheckoutUnavailableError, QuotaExceededError, SubscriptionActiveError } from '../../src/modules/billing/application/errors';
import { orderRef, ProcessBillingEvent } from '../../src/modules/billing/application/process-billing-event.handler';
import { ReceiveWebhook, verifySignature, WebhookSignatureError } from '../../src/modules/billing/application/receive-webhook.usecase';
import { ReservePath } from '../../src/modules/billing/application/reserve-path.usecase';

const SECRET = 'unit-webhook-secret-'.padEnd(40, 'z');
const USER = randomUUID();

function setup(mode: 'test' | 'live' = 'test') {
  const config = new AppConfig({
    LEMONSQUEEZY_STORE_ID: '100001',
    LEMONSQUEEZY_WEBHOOK_SECRET: SECRET,
    LEMONSQUEEZY_VARIANT_SUBSCRIPTION: VARIANTS.subscription,
    LEMONSQUEEZY_VARIANT_CREDIT_PACK: VARIANTS.creditPack,
    LEMONSQUEEZY_MODE: mode,
    APP_ORIGIN: ['https://eduujoy.aindrajaya.my.id', 'http://localhost:5173'],
  } as Env);
  const repo = new FakeBillingRepository();
  repo.users.add(USER);
  const provider = new FakeBillingProvider();
  const bus = new EventBus(new EventEmitter2());
  const changes: EntitlementChanged[] = [];
  bus.on<EntitlementChanged>('EntitlementChanged', (e) => changes.push(e));
  const db = { transaction: ((fn: (tx: never) => unknown) => fn({} as never)) as Database['transaction'] };
  const enqueued: { type: string; payload: unknown; idempotencyKey: string }[] = [];
  const queue = { enqueue: (r: { type: string; payload: unknown; idempotencyKey: string }) => (enqueued.push(r), Promise.resolve()) } as unknown as JobQueue;
  const processor = new ProcessBillingEvent(repo, new LemonSqueezyNotificationParser(), provider, config, bus);
  const receive = new ReceiveWebhook(repo, new UnitOfWork(db, bus), queue, config);

  /** Receives a signed webhook and runs its job, as the executor would. */
  async function deliver(payload: unknown): Promise<string | undefined> {
    const raw = Buffer.from(JSON.stringify(payload));
    const result = await receive.execute(raw, sign(raw));
    if (result !== 'accepted') return result;
    const job = enqueued.at(-1);
    if (!job) throw new Error('nothing enqueued');
    const outcome = await processor.run(processor.parse(job.payload));
    return (outcome.result as { outcome: string }).outcome;
  }
  return { repo, provider, changes, enqueued, deliver, receive, checkout: new CreateCheckout(provider, fakeQuotaRepository(repo), config), reserve: new ReservePath(repo) };
}

const sign = (raw: Buffer, secret = SECRET) => createHmac('sha256', secret).update(raw).digest('hex');

describe('webhook signature', () => {
  it('accepts the hex HMAC-SHA256 of the raw body only', () => {
    const raw = Buffer.from('{"meta":{}}');
    expect(verifySignature(raw, sign(raw), SECRET)).toBe(true);
    expect(verifySignature(raw, sign(raw).toUpperCase(), SECRET)).toBe(true);
    expect(verifySignature(Buffer.from('{"meta": {}}'), sign(raw), SECRET)).toBe(false);
    expect(verifySignature(raw, sign(raw, 'another-secret-value-xxxxxxxxxxxxxxxx'), SECRET)).toBe(false);
    for (const bad of [undefined, '', 'abc', 'z'.repeat(64), `${sign(raw)}00`]) expect(verifySignature(raw, bad, SECRET)).toBe(false);
  });

  it('rejects an unsigned or wrongly signed webhook before storing anything', async () => {
    const t = setup();
    const raw = Buffer.from(JSON.stringify(orderEvent({ userId: USER })));

    await expect(t.receive.execute(raw, undefined)).rejects.toBeInstanceOf(WebhookSignatureError);
    await expect(t.receive.execute(raw, sign(raw, 'x'.repeat(40)))).rejects.toBeInstanceOf(WebhookSignatureError);
    await expect(t.receive.execute(undefined, 'a'.repeat(64))).rejects.toBeInstanceOf(WebhookSignatureError);
    expect(t.repo.events.size).toBe(0);
  });
});

describe('credit packs', () => {
  it('credits 1 per pack from the order items, once per order and once per delivery', async () => {
    const t = setup();
    t.provider.orderItems.set('5001', [{ variantId: VARIANTS.creditPack, quantity: 3 }]);
    const payload = orderEvent({ userId: USER, orderId: 5001 });

    await expect(t.deliver(payload)).resolves.toBe('credited:3');
    // Redelivery of the same body is a replay; a different body for the same order credits nothing.
    await expect(t.deliver(payload)).resolves.toBe('replay');
    await expect(t.deliver({ ...payload, meta: { ...(payload['meta'] as object), extra: 1 } })).resolves.toBe('ignored:already_credited');

    expect(t.repo.balance(USER)).toBe(3);
    expect(t.changes).toEqual([expect.objectContaining({ userId: USER, reason: 'purchase' })]);
    expect(t.enqueued[0]).toMatchObject({ type: 'billing-event', idempotencyKey: expect.stringMatching(/^billing:/) as unknown });
  });

  it('credits a paid order over 10 packs with a flag, and holds zero-quantity, unpaid and user-less orders', async () => {
    const t = setup();
    t.provider.orderItems.set('5001', [{ variantId: VARIANTS.creditPack, quantity: 11 }]);
    t.provider.orderItems.set('5005', []);

    await expect(t.deliver(orderEvent({ userId: USER, orderId: 5001 }))).resolves.toBe('credited:11:over_cap_11');
    await expect(t.deliver(orderEvent({ userId: USER, orderId: 5005 }))).resolves.toBe('held:quantity_0');
    await expect(t.deliver(orderEvent({ userId: USER, orderId: 5002, status: 'pending' }))).resolves.toBe('ignored:order_pending');
    await expect(t.deliver(orderEvent({ userId: null, orderId: 5003 }))).resolves.toBe('held:no_user');
    await expect(t.deliver(orderEvent({ userId: randomUUID(), orderId: 5004 }))).resolves.toMatch(/^held:(quantity_0|unknown_user)$/);
    expect(t.repo.balance(USER)).toBe(11);
  });

  it('ignores unknown variants and events from the other mode', async () => {
    const t = setup();
    t.provider.orderItems.set('5001', [{ variantId: VARIANTS.creditPack, quantity: 1 }]);

    await expect(t.deliver(orderEvent({ userId: USER, variantId: VARIANTS.other }))).resolves.toBe('ignored:unknown_variant');
    await expect(t.deliver(orderEvent({ userId: USER, orderId: 5001, testMode: false }))).resolves.toBe('ignored:mode_mismatch');
    const live = setup('live');
    live.provider.orderItems.set('5001', [{ variantId: VARIANTS.creditPack, quantity: 1 }]);
    await expect(live.deliver(orderEvent({ userId: USER, orderId: 5001, testMode: true }))).resolves.toBe('ignored:mode_mismatch');
    expect(t.repo.balance(USER) + live.repo.balance(USER)).toBe(0);
  });

  it('claws back only unspent credits on refund, once, and reports spent ones', async () => {
    const t = setup();
    t.provider.orderItems.set('5001', [{ variantId: VARIANTS.creditPack, quantity: 3 }]);
    await t.deliver(orderEvent({ userId: USER, orderId: 5001, total: 600 }));
    // Two credits spent on paths.
    t.repo.ledger.push({ userId: USER, delta: -2, reason: 'path', externalRef: 'path:p1', createdAt: new Date() });

    const refund = orderEvent({ event: 'order_refunded', userId: USER, orderId: 5001, status: 'refunded', refunded: true, refundedAmount: 600, total: 600 });
    await expect(t.deliver(refund)).resolves.toBe('refunded:1:shortfall_2');
    await expect(t.deliver({ ...refund, meta: { ...(refund['meta'] as object), retry: true } })).resolves.toBe('ignored:refund_already_applied');
    expect(t.repo.balance(USER)).toBe(0);
  });

  it('retries the job when the provider API fails, without recording the event as processed', async () => {
    const t = setup();
    t.provider.failOrderItems = true;

    await expect(t.deliver(orderEvent({ userId: USER, orderId: 5001 }))).rejects.toThrow('HTTP 503');
    expect([...t.repo.events.values()][0]?.processedAt).toBeNull();
  });
});

describe('subscriptions', () => {
  it('grants 8 paths per month, follows the lifecycle and skips out-of-order updates', async () => {
    const t = setup();

    await expect(t.deliver(subscriptionEvent({ userId: USER, updatedAt: '2026-10-22T10:00:00Z' }))).resolves.toBe('subscription:active');
    expect(t.repo.entitlements.get(USER)).toMatchObject({ plan: 'subscription', monthlyPathQuota: 8, periodEnd: new Date('2099-11-22T10:00:00Z') });

    const cancelled = subscriptionEvent({ event: 'subscription_cancelled', userId: USER, status: 'cancelled', endsAt: '2099-11-01T00:00:00Z', updatedAt: '2026-10-23T10:00:00Z' });
    await expect(t.deliver(cancelled)).resolves.toBe('subscription:cancelled');
    expect(t.repo.entitlements.get(USER)?.periodEnd).toEqual(new Date('2099-11-01T00:00:00Z'));

    // An older update arriving late must not revive the cancelled plan's renewal date.
    await expect(t.deliver(subscriptionEvent({ event: 'subscription_updated', userId: USER, updatedAt: '2026-10-22T11:00:00Z' }))).resolves.toBe('ignored:stale_subscription_update');

    await expect(t.deliver(subscriptionEvent({ event: 'subscription_expired', userId: USER, status: 'expired', updatedAt: '2026-10-24T10:00:00Z' }))).resolves.toBe('subscription:expired');
    expect((t.repo.entitlements.get(USER)?.periodEnd.getTime() ?? Infinity) <= Date.now()).toBe(true);
    expect(t.changes.map((c) => c.reason)).toEqual(['subscription', 'subscription', 'subscription']);
  });

  it('ignores events for a second subscription that would downgrade the running one, and refunds by order', async () => {
    const t = setup();
    await expect(t.deliver(subscriptionEvent({ userId: USER, subscriptionId: 1 }))).resolves.toBe('subscription:active');

    // An older subscription of the same learner expires: the running plan stays.
    await expect(t.deliver(subscriptionEvent({ event: 'subscription_expired', userId: USER, subscriptionId: 2, status: 'expired', updatedAt: '2026-10-23T10:00:00Z' }))).resolves.toBe('ignored:other_subscription');
    expect(t.repo.entitlements.get(USER)).toMatchObject({ subscriptionId: '1', periodEnd: new Date('2099-11-22T10:00:00Z') });

    // Refunding an order that didn't start the stored subscription ends nothing.
    const refund = (orderId: number) => orderEvent({ event: 'order_refunded', userId: USER, orderId, variantId: VARIANTS.subscription, status: 'refunded', refunded: true, refundedAmount: 999, total: 999 });
    await expect(t.deliver(refund(9999))).resolves.toBe('ignored:unknown_subscription');
    await expect(t.deliver(refund(5002))).resolves.toBe('subscription:ended_refund');
  });

  it('ends the plan at once on a full subscription refund, and only logs a partial one', async () => {
    const t = setup();
    await t.deliver(subscriptionEvent({ userId: USER }));

    await expect(t.deliver(invoiceRefundEvent({ refunded: false }))).resolves.toBe('logged:partial_subscription_refund');
    expect((t.repo.entitlements.get(USER)?.periodEnd.getTime() ?? 0) > Date.now()).toBe(true);
    await expect(t.deliver(invoiceRefundEvent({}))).resolves.toBe('subscription:ended_refund');
    expect((t.repo.entitlements.get(USER)?.periodEnd.getTime() ?? Infinity) <= Date.now()).toBe(true);
  });

  it('ignores other events and payloads it cannot parse', async () => {
    const t = setup();
    await expect(t.deliver({ meta: { event_name: 'license_key_created' }, data: { type: 'license-keys', attributes: {} } })).resolves.toBe('ignored:event:license_key_created');
    await expect(t.deliver({ meta: { event_name: 'order_created' }, data: { type: 'orders' } })).resolves.toBe('ignored:invalid_payload');
    const raw = Buffer.from('not json');
    await expect(t.receive.execute(raw, sign(raw))).resolves.toBe('unparseable');
  });
});

describe('ReservePath (quota blocks generation)', () => {
  it('uses the free path, then credits, then answers QuotaExceeded; repeats are idempotent', async () => {
    const t = setup();
    t.repo.ledger.push({ userId: USER, delta: 1, reason: 'purchase', externalRef: orderRef('1'), createdAt: new Date() });

    await expect(t.reserve.execute(USER, 'p1')).resolves.toBe('plan');
    await expect(t.reserve.execute(USER, 'p1')).resolves.toBe('plan');
    await expect(t.reserve.execute(USER, 'p2')).resolves.toBe('credit');
    const error = await t.reserve.execute(USER, 'p3').catch((e: unknown) => e);
    expect(error).toBeInstanceOf(QuotaExceededError);
    expect(error).toMatchObject({ monthlyPaths: 1 });
    expect(t.repo.balance(USER)).toBe(0);
  });

  it('gives subscribers 8 plan-covered paths per period', async () => {
    const t = setup();
    await t.deliver(subscriptionEvent({ userId: USER }));
    for (let i = 0; i < 8; i++) await expect(t.reserve.execute(USER, `s${i}`)).resolves.toBe('plan');
    await expect(t.reserve.execute(USER, 's8')).rejects.toBeInstanceOf(QuotaExceededError);
  });
});

describe('CreateCheckout', () => {
  const ORIGIN = 'http://localhost:5173';

  it('creates a checkout for the configured variant, returning the learner to the request origin', async () => {
    const t = setup();

    await expect(t.checkout.execute(USER, 'credit_pack', ORIGIN)).resolves.toEqual({ url: 'https://eduujoy.lemonsqueezy.com/checkout/custom/abc' });
    await t.checkout.execute(USER, 'subscription', ORIGIN);

    expect(t.provider.checkouts).toEqual([
      { storeId: '100001', variantId: VARIANTS.creditPack, userId: USER, testMode: true, redirectUrl: 'http://localhost:5173/account?checkout=success', quantity: 1 },
      { storeId: '100001', variantId: VARIANTS.subscription, userId: USER, testMode: true, redirectUrl: 'http://localhost:5173/account?checkout=success', quantity: 1 },
    ]);
  });

  it('presets the chosen pack quantity on credit-pack checkouts only', async () => {
    const t = setup();
    await t.checkout.execute(USER, 'credit_pack', ORIGIN, 7);
    await t.checkout.execute(USER, 'subscription', ORIGIN, 7);
    expect(t.provider.checkouts.map((c) => c.quantity)).toEqual([7, 1]);
  });

  it('never returns the learner to an origin outside APP_ORIGIN', async () => {
    const t = setup();
    for (const origin of ['https://evil.example', undefined]) await t.checkout.execute(USER, 'credit_pack', origin);
    expect(t.provider.checkouts.map((c) => c.redirectUrl)).toEqual([
      'https://eduujoy.aindrajaya.my.id/account?checkout=success',
      'https://eduujoy.aindrajaya.my.id/account?checkout=success',
    ]);
  });

  it('refuses a second subscription while one is active, but still sells credit packs (409)', async () => {
    const t = setup();
    await t.deliver(subscriptionEvent({ userId: USER }));

    await expect(t.checkout.execute(USER, 'subscription', ORIGIN)).rejects.toBeInstanceOf(SubscriptionActiveError);
    await expect(t.checkout.execute(USER, 'credit_pack', ORIGIN)).resolves.toMatchObject({ url: expect.any(String) as unknown });
    // Once the plan has ended, subscribing again is allowed.
    await t.deliver(subscriptionEvent({ event: 'subscription_expired', userId: USER, status: 'expired', updatedAt: '2026-10-23T10:00:00Z' }));
    await expect(t.checkout.execute(USER, 'subscription', ORIGIN)).resolves.toMatchObject({ url: expect.any(String) as unknown });
  });

  it('answers 503 when the provider fails or returns a URL outside https://*.lemonsqueezy.com', async () => {
    const t = setup();
    t.provider.failCheckout = true;
    await expect(t.checkout.execute(USER, 'credit_pack', ORIGIN)).rejects.toMatchObject({ name: 'CheckoutUnavailableError', retryAfterSeconds: 30 });
    t.provider.failCheckout = false;
    t.provider.checkoutUrl = 'https://evil.example/checkout';
    await expect(t.checkout.execute(USER, 'credit_pack', ORIGIN)).rejects.toBeInstanceOf(CheckoutUnavailableError);
    expect(['http://x.lemonsqueezy.com/a', 'https://lemonsqueezy.com.evil.io/a', 'javascript:alert(1)'].map(isProviderCheckoutUrl)).toEqual([false, false, false]);
  });
});
