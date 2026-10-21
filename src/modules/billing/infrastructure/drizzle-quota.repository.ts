import { Inject, Injectable } from '@nestjs/common';
import { and, eq, gte, lt, sql } from 'drizzle-orm';
import { DATABASE, type Database } from '../../../shared/db';
import { creditLedger, entitlements } from '../../../shared/db/schema/billing';
import { type QuotaRepository } from '../application/ports/quota.repository';
import { type Entitlement } from '../domain/quota';

@Injectable()
export class DrizzleQuotaRepository implements QuotaRepository {
  constructor(@Inject(DATABASE) private readonly db: Database) {}

  async findEntitlement(userId: string): Promise<Entitlement | null> {
    const [row] = await this.db
      .select({
        plan: entitlements.plan,
        monthlyPathQuota: entitlements.monthlyPathQuota,
        periodStart: entitlements.periodStart,
        periodEnd: entitlements.periodEnd,
      })
      .from(entitlements)
      .where(eq(entitlements.userId, userId));
    return row ?? null;
  }

  async creditBalance(userId: string): Promise<number> {
    const [row] = await this.db
      .select({ balance: sql<number>`coalesce(sum(${creditLedger.delta}), 0)::int` })
      .from(creditLedger)
      .where(eq(creditLedger.userId, userId));
    return row?.balance ?? 0;
  }

  async countPlanCoveredPaths(userId: string, from: Date, to: Date): Promise<number> {
    const [row] = await this.db
      .select({ n: sql<number>`count(*)::int` })
      .from(creditLedger)
      .where(
        and(
          eq(creditLedger.userId, userId),
          eq(creditLedger.reason, 'path'),
          eq(creditLedger.delta, 0),
          gte(creditLedger.createdAt, from),
          lt(creditLedger.createdAt, to),
        ),
      );
    return row?.n ?? 0;
  }
}
