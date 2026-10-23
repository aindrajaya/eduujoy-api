import { Inject, Injectable } from '@nestjs/common';
import { eq, sql } from 'drizzle-orm';
import { DATABASE, type Database } from '../../../shared/db';
import { creditLedger, entitlements } from '../../../shared/db/schema/billing';
import { type QuotaRepository } from '../application/ports/quota.repository';
import { type Entitlement } from '../domain/quota';
import { planCoveredPaths } from './ledger-conditions';

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
      .where(planCoveredPaths(userId, from, to));
    return row?.n ?? 0;
  }
}
