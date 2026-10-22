import { Inject, Injectable } from '@nestjs/common';
import { and, eq, sql } from 'drizzle-orm';
import { DATABASE, type Database } from '../../../shared/db';
import { providerQuotaUsage } from '../../../shared/db/schema/discovery';
import { type QuotaCounter } from '../application/ports/quota-counter';

/** Counts in Postgres, so every instance shares one daily count (an atomic conditional upsert). */
@Injectable()
export class DrizzleQuotaCounter implements QuotaCounter {
  constructor(@Inject(DATABASE) private readonly db: Database) {}

  async tryTake(quota: string, day: string, limit: number): Promise<boolean> {
    const rows = await this.db
      .insert(providerQuotaUsage)
      .values({ quota, day, used: 1 })
      .onConflictDoUpdate({
        target: [providerQuotaUsage.quota, providerQuotaUsage.day],
        set: { used: sql`${providerQuotaUsage.used} + 1`, updatedAt: sql`now()` },
        setWhere: sql`${providerQuotaUsage.used} < ${limit}`,
      })
      .returning({ used: providerQuotaUsage.used });
    return rows.length > 0 && limit > 0;
  }

  async exhaust(quota: string, day: string, limit: number): Promise<void> {
    await this.db
      .insert(providerQuotaUsage)
      .values({ quota, day, used: limit })
      .onConflictDoUpdate({ target: [providerQuotaUsage.quota, providerQuotaUsage.day], set: { used: sql`greatest(${providerQuotaUsage.used}, ${limit})`, updatedAt: sql`now()` } });
  }

  async used(quota: string, day: string): Promise<number> {
    const [row] = await this.db
      .select({ used: providerQuotaUsage.used })
      .from(providerQuotaUsage)
      .where(and(eq(providerQuotaUsage.quota, quota), eq(providerQuotaUsage.day, day)));
    return row?.used ?? 0;
  }
}
