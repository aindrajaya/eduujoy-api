import { type Client } from 'pg';
import { DrizzleQuotaRepository } from '../../src/modules/billing/infrastructure/drizzle-quota.repository';
import { creditLedger, entitlements } from '../../src/shared/db/schema/billing';
import { users } from '../../src/shared/db/schema/identity';
import { connectTestClient, testDb, type TestDb } from '../db/connect';

describe('DrizzleQuotaRepository (integration)', () => {
  let client: Client;
  let db: TestDb;
  let repo: DrizzleQuotaRepository;
  let userId: string;

  beforeAll(async () => {
    client = await connectTestClient();
    db = testDb(client);
    repo = new DrizzleQuotaRepository(db);
    const [user] = await db.insert(users).values({ email: 'quota-int@example.com' }).returning();
    userId = user?.id ?? '';
  });

  afterAll(async () => {
    await client.end();
  });

  it('returns null and zeros for a user without billing rows', async () => {
    await expect(repo.findEntitlement(userId)).resolves.toBeNull();
    await expect(repo.creditBalance(userId)).resolves.toBe(0);
  });

  it('sums the ledger and counts only plan-covered paths inside the period', async () => {
    await db.insert(creditLedger).values([
      { userId, delta: 5, reason: 'purchase', externalRef: 'order-1' },
      { userId, delta: -1, reason: 'path' },
      { userId, delta: 0, reason: 'path', createdAt: new Date('2026-10-05T00:00:00Z') },
      { userId, delta: 0, reason: 'path', createdAt: new Date('2026-09-30T23:59:59Z') },
    ]);

    await expect(repo.creditBalance(userId)).resolves.toBe(4);
    await expect(
      repo.countPlanCoveredPaths(userId, new Date('2026-10-01T00:00:00Z'), new Date('2026-11-01T00:00:00Z')),
    ).resolves.toBe(1);
  });

  it('reads the entitlement row', async () => {
    const periodStart = new Date('2026-10-10T00:00:00Z');
    const periodEnd = new Date('2026-11-10T00:00:00Z');
    await db.insert(entitlements).values({ userId, plan: 'subscription', monthlyPathQuota: 8, periodStart, periodEnd });

    await expect(repo.findEntitlement(userId)).resolves.toEqual({
      plan: 'subscription',
      monthlyPathQuota: 8,
      periodStart,
      periodEnd,
    });
  });
});
