import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { type Client } from 'pg';
import { DrizzleBillingRepository } from '../../src/modules/billing/infrastructure/drizzle-billing.repository';
import { billingEvents, creditLedger } from '../../src/shared/db/schema/billing';
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

  it('moves a subscription forward in provider time only, and ends it by subscription id', async () => {
    const userId = await user();
    const subscriptionId = `sub-${randomUUID()}`;
    const t1 = new Date('2026-10-22T10:00:00Z');

    await expect(repo.upsertSubscription({ userId, subscriptionId, entitlement: sub(FUTURE), providerUpdatedAt: t1 })).resolves.toBe('applied');
    await expect(repo.upsertSubscription({ userId, subscriptionId, entitlement: sub(new Date()), providerUpdatedAt: t1 })).resolves.toBe('stale');
    await expect(repo.subscriptionOf(userId)).resolves.toBe(subscriptionId);
    await expect(repo.upsertSubscription({ userId: randomUUID(), subscriptionId: 'x', entitlement: sub(FUTURE), providerUpdatedAt: t1 })).resolves.toBe('unknown_user');

    const now = new Date();
    await expect(repo.endSubscription(subscriptionId, { ...sub(now) })).resolves.toBe(userId);
    await expect(repo.endSubscription('nope', sub(now))).resolves.toBeNull();
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
});
