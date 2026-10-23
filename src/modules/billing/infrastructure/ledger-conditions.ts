import { and, eq, gte, lt, type SQL, sql } from 'drizzle-orm';
import { creditLedger } from '../../../shared/db/schema/billing';

/**
 * A learner's plan-covered path charges (reason `path`, delta 0) in [from, to) that were not refunded
 * (A9): what counts against the monthly allowance, for both the charge and the quota read. Inside the
 * subquery the ledger is aliased `r`, so `credit_ledger.external_ref` is the outer charge row.
 */
export function planCoveredPaths(userId: string, from: Date, to: Date): SQL | undefined {
  return and(
    eq(creditLedger.userId, userId),
    eq(creditLedger.reason, 'path'),
    eq(creditLedger.delta, 0),
    gte(creditLedger.createdAt, from),
    lt(creditLedger.createdAt, to),
    sql`not exists (select 1 from ${creditLedger} as r where r.reason = 'refund' and r.external_ref = ${creditLedger.externalRef})`,
  );
}
