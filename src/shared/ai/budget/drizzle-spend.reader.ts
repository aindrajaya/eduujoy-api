import { Inject, Injectable } from '@nestjs/common';
import { gte, sql } from 'drizzle-orm';
import { DATABASE, type Database } from '../../db';
import { llmCalls } from '../../db/schema/ai';
import { type SpendReader } from './budget.guard';

@Injectable()
export class DrizzleSpendReader implements SpendReader {
  constructor(@Inject(DATABASE) private readonly db: Database) {}

  async spentSince(since: Date): Promise<number> {
    const [row] = await this.db
      .select({ total: sql<string>`coalesce(sum(${llmCalls.costUsd}), 0)` })
      .from(llmCalls)
      .where(gte(llmCalls.createdAt, since));
    return Number(row?.total ?? 0);
  }
}
