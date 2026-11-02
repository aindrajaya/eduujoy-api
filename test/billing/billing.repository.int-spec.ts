import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { type Client } from 'pg';
import { DrizzleBillingRepository } from '../../src/modules/billing/infrastructure/drizzle-billing.repository';
import { DrizzleQuotaRepository } from '../../src/modules/billing/infrastructure/drizzle-quota.repository';
import { billingEvents, creditLedger, entitlements } from '../../src/shared/db/schema/billing';
import { users } from '../../src/shared/db/schema/identity';
import { connectTestClient, testDb, type TestDb } from '../db/connect';

const FUTURE = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000);
const sub = (periodEnd: Date) => ({ plan: 'subscription' as const, monthlyPathQuota: 8, periodStart: new Date(Date.now() - 60_000), periodEnd });

describe('DrizzleBillingRepository (integration)', () => {
  let client: Client;
  let db: TestDb;
  let repo: DrizzleBillingRepository;

  beforeAll(async () => {
    client = await connectTestClient();
    db = testDb(client);
    repo = new DrizzleBillingRepository(db);
  });

  afterAll(async () => {
    await client.end();
  });

  async function user(): Promise<string> {
    const [row] = await db.insert(users).values({ email: `billing-${randomUUID()}@example.com` }).returning();
    return row?.id ?? '';
  }
  const balance = async (userId: string) =>
    (await db.select({ delta: creditLedger.delta }).from(creditLedger).where(eq(creditLedger.userId, userId))).reduce((s, r) => s + r.delta, 0);

  it('stores a webhook once per provider event id and marks it processed once', async () => {
    const providerEventId = randomUUID();
    const first = await db.transaction((tx) => repo.recordEvent(tx, { providerEventId, type: 'order_created', payload: { a: 1 } }));
    const again = await db.transaction((tx) => repo.recordEvent(tx, { providerEventId, type: 'order_created', payload: { a: 1 } }));

    expect(first).toEqual(expect.any(String));
    expect(again).toBeNull();
    await repo.markProcessed(first ?? '', 'credited:1');
    await repo.markProcessed(first ?? '', 'overwritten');
    const [row] = await db.select().from(billingEvents).where(eq(billingEvents.id, first ?? ''));
    expect(row).toMatchObject({ outcome: 'credited:1', processedAt: expect.any(Date) as unknown });
  });

  it('credits a purchase once per order and reports an unknown user', async () => {
    const userId = await user();
    const orderRef = `ls-order:${randomUUID()}`;

    await expect(repo.grantPurchase({ userId, credits: 3, orderRef })).resolves.toBe('granted');
    await expect(repo.grantPurchase({ userId, credits: 3, orderRef })).resolves.toBe('duplicate');
    await expect(repo.grantPurchase({ userId: randomUUID(), credits: 1, orderRef: `ls-order:${randomUUID()}` })).resolves.toBe('unknown_user');
    await expect(repo.findPurchase(orderRef)).resolves.toEqual({ userId, credits: 3 });
    expect(await balance(userId)).toBe(3);
  });

  it('applies a refund once per cumulative target, seeing earlier claw-backs and the balance', async () => {
    const userId = await user();
    const orderRef = `ls-order:${randomUUID()}`;
    await repo.grantPurchase({ userId, credits: 4, orderRef });
    const seen: { balance: number; alreadyClawedBack: number }[] = [];

    await expect(repo.applyRefund({ userId, orderRef }, (s) => (seen.push(s), { target: 2, delta: -2 }))).resolves.toBe('applied');
    await expect(repo.applyRefund({ userId, orderRef }, (s) => (seen.push(s), { target: 2, delta: 0 }))).resolves.toBe('duplicate');
    await expect(repo.applyRefund({ userId, orderRef }, (s) => (seen.push(s), { target: 4, delta: -2 }))).resolves.toBe('applied');

    expect(seen).toEqual([{ balance: 4, alreadyClawedBack: 0 }, { balance: 2, alreadyClawedBack: 2 }, { balance: 2, alreadyClawedBack: 2 }]);
    expect(await balance(userId)).toBe(0);
  });

  it('moves a subscription forward in provider time only, and ends it by subscription or order id', async () => {
    const userId = await user();
    const subscriptionId = `sub-${randomUUID()}`;
    const orderId = `ord-${randomUUID()}`;
    const t1 = new Date('2026-10-22T10:00:00Z');
    const now = new Date();
    const base = { userId, subscriptionId, orderId, now };

    await expect(repo.upsertSubscription({ ...base, entitlement: sub(FUTURE), providerUpdatedAt: t1 })).resolves.toBe('applied');
    await expect(repo.upsertSubscription({ ...base, entitlement: sub(new Date()), providerUpdatedAt: t1 })).resolves.toBe('stale');
    await expect(repo.upsertSubscription({ ...base, userId: randomUUID(), entitlement: sub(FUTURE), providerUpdatedAt: t1 })).resolves.toBe('unknown_user');

    await expect(repo.endSubscriptionForOrder('ord-other', sub(now))).resolves.toBeNull();
    await expect(repo.endSubscriptionForOrder(orderId, sub(now))).resolves.toBe(userId);
    await expect(repo.endSubscription('nope', sub(now))).resolves.toBeNull();
    await expect(repo.endSubscription(subscriptionId, sub(now))).resolves.toBe(userId);
  });

  it('never lets events for a second subscription drop a paying learner to free (lead gate finding 1)', async () => {
    const userId = await user();
    const [a, b] = [`sub-a-${randomUUID()}`, `sub-b-${randomUUID()}`];
    const now = new Date();
    const day = 24 * 60 * 60 * 1000;
    const at = (h: number) => new Date(Date.UTC(2026, 9, 22, h));
    const periodEnd = async () => (await db.select().from(entitlements).where(eq(entitlements.userId, userId)))[0];

    // A is active for 30 days.
    await expect(repo.upsertSubscription({ userId, subscriptionId: a, orderId: 'ord-a', entitlement: sub(new Date(now.getTime() + 30 * day)), providerUpdatedAt: at(1), now })).resolves.toBe('applied');
    // B (an older, lapsed subscription) expires, or a late B update arrives: A is untouched.
    await expect(repo.upsertSubscription({ userId, subscriptionId: b, orderId: 'ord-b', entitlement: sub(now), providerUpdatedAt: at(2), now })).resolves.toBe('other_subscription');
    await expect(repo.upsertSubscription({ userId, subscriptionId: b, orderId: 'ord-b', entitlement: sub(new Date(now.getTime() + 10 * day)), providerUpdatedAt: at(3), now })).resolves.toBe('other_subscription');
    expect((await periodEnd())?.providerSubscriptionId).toBe(a);
    // B's order is refunded: A still runs.
    await expect(repo.endSubscriptionForOrder('ord-b', sub(now))).resolves.toBeNull();
    expect(((await periodEnd())?.periodEnd.getTime() ?? 0) > now.getTime()).toBe(true);

    // A new subscription C that runs longer takes over; then A's expiry is another subscription's event.
    const c = `sub-c-${randomUUID()}`;
    await expect(repo.upsertSubscription({ userId, subscriptionId: c, orderId: 'ord-c', entitlement: sub(new Date(now.getTime() + 60 * day)), providerUpdatedAt: at(4), now })).resolves.toBe('applied');
    await expect(repo.upsertSubscription({ userId, subscriptionId: a, orderId: 'ord-a', entitlement: sub(now), providerUpdatedAt: at(5), now })).resolves.toBe('other_subscription');
    expect(await periodEnd()).toMatchObject({ providerSubscriptionId: c, providerOrderId: 'ord-c' });

    // Once the stored subscription has ended, any other subscription may replace it.
    await repo.endSubscription(c, sub(now));
    const later = new Date(now.getTime() + 1000);
    await expect(repo.upsertSubscription({ userId, subscriptionId: b, orderId: 'ord-b', entitlement: sub(new Date(now.getTime() + 5 * day)), providerUpdatedAt: at(6), now: later })).resolves.toBe('applied');
  });

  it('charges each path once and never oversells credits under parallel requests', async () => {
    const userId = await user();
    await repo.grantPurchase({ userId, credits: 2, orderRef: `ls-order:${randomUUID()}` });
    const decide = async (state: { balance: number; usedPathsBetween: (a: Date, b: Date) => Promise<number> }) => {
      const used = await state.usedPathsBetween(new Date(0), new Date(Date.now() + 60_000));
      if (used < 1) return 'plan' as const;
      return state.balance > 0 ? ('credit' as const) : ('exceeded' as const);
    };

    // Separate connections so the six charges really race; the per-user advisory lock serialises them.
    const clients = await Promise.all(Array.from({ length: 6 }, () => connectTestClient()));
    try {
      const charges = await Promise.all(clients.map((c, i) => new DrizzleBillingRepository(testDb(c)).reservePath({ userId, pathRef: `p${i}` }, decide)));
      expect([...charges].sort()).toEqual(['credit', 'credit', 'exceeded', 'exceeded', 'exceeded', 'plan']);
      // Charging a path again returns its earlier charge without writing another row.
      const charged = charges.findIndex((c) => c !== 'exceeded');
      await expect(repo.reservePath({ userId, pathRef: `p${charged}` }, decide)).resolves.toBe(charges[charged]);
    } finally {
      await Promise.all(clients.map((c) => c.end()));
    }
    expect(await balance(userId)).toBe(0);
  });

  it('refunds a path once: a credit comes back, a plan slot frees up, and nothing is charged twice (A9)', async () => {
    const userId = await user();
    await repo.grantPurchase({ userId, credits: 1, orderRef: `ls-order:${randomUUID()}` });
    const window = [new Date(0), new Date(Date.now() + 60_000)] as const;
    // One plan slot this period, then credits.
    const decide = async (state: { balance: number; usedPathsBetween: (a: Date, b: Date) => Promise<number> }) => {
      if ((await state.usedPathsBetween(...window)) < 1) return 'plan' as const;
      return state.balance > 0 ? ('credit' as const) : ('exceeded' as const);
    };
    const quota = new DrizzleQuotaRepository(db);

    await expect(repo.reservePath({ userId, pathRef: 'a' }, decide)).resolves.toBe('plan');
    await expect(repo.reservePath({ userId, pathRef: 'b' }, decide)).resolves.toBe('credit');
    await expect(repo.reservePath({ userId, pathRef: 'c' }, decide)).resolves.toBe('exceeded');
    expect(await balance(userId)).toBe(0);
    expect(await quota.countPlanCoveredPaths(userId, ...window)).toBe(1);

    // The credit-paid path and the plan-paid path fail for good: each is refunded exactly once.
    await expect(repo.refundPath({ userId, pathRef: 'b' })).resolves.toBe('refunded');
    await expect(repo.refundPath({ userId, pathRef: 'b' })).resolves.toBe('duplicate');
    await expect(repo.refundPath({ userId, pathRef: 'a' })).resolves.toBe('refunded');
    await expect(repo.refundPath({ userId, pathRef: 'a' })).resolves.toBe('duplicate');
    await expect(repo.refundPath({ userId, pathRef: 'never-charged' })).resolves.toBe('not_charged');
    await expect(repo.refundPath({ userId: await user(), pathRef: 'a' })).resolves.toBe('not_charged');
    expect(await balance(userId)).toBe(1);
    expect(await quota.countPlanCoveredPaths(userId, ...window)).toBe(0);

    // Re-charging a refunded path returns its earlier charge and writes nothing; a new path uses the freed slot.
    await expect(repo.reservePath({ userId, pathRef: 'a' }, decide)).resolves.toBe('plan');
    await expect(repo.reservePath({ userId, pathRef: 'd' }, decide)).resolves.toBe('plan');
    await expect(repo.reservePath({ userId, pathRef: 'e' }, decide)).resolves.toBe('credit');
    expect(await balance(userId)).toBe(0);
    const rows = await db.select({ reason: creditLedger.reason, ref: creditLedger.externalRef, delta: creditLedger.delta }).from(creditLedger).where(eq(creditLedger.userId, userId));
    expect(rows.filter((r) => r.reason === 'refund').sort((x, y) => (x.ref ?? '').localeCompare(y.ref ?? ''))).toEqual([
      { reason: 'refund', ref: 'path:a', delta: 0 },
      { reason: 'refund', ref: 'path:b', delta: 1 },
    ]);
  });
});
