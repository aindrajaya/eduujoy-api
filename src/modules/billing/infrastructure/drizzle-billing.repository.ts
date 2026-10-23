import { Inject, Injectable } from '@nestjs/common';
import { and, eq, isNull, like, sql } from 'drizzle-orm';
import { DATABASE, type Database, type Tx } from '../../../shared/db';
import { billingEvents, creditLedger, entitlements } from '../../../shared/db/schema/billing';
import {
  type BillingRepository,
  type LockedQuotaState,
  type PathCharge,
  type StoredBillingEvent,
} from '../application/ports/billing.repository';
import { type Entitlement } from '../domain/quota';
import { planCoveredPaths } from './ledger-conditions';

/** Postgres foreign_key_violation: the webhook's user id doesn't exist (deleted, or forged custom data). */
const FOREIGN_KEY_VIOLATION = '23503';

function pgCode(error: unknown): string | undefined {
  const own = (error as { code?: unknown }).code;
  const cause = (error as { cause?: { code?: unknown } }).cause?.code;
  return typeof own === 'string' ? own : typeof cause === 'string' ? cause : undefined;
}

@Injectable()
export class DrizzleBillingRepository implements BillingRepository {
  constructor(@Inject(DATABASE) private readonly db: Database) {}

  async recordEvent(tx: Tx, event: { providerEventId: string; type: string; payload: unknown }): Promise<string | null> {
    const [row] = await tx
      .insert(billingEvents)
      .values({ providerEventId: event.providerEventId, type: event.type, payload: event.payload })
      .onConflictDoNothing({ target: billingEvents.providerEventId })
      .returning({ id: billingEvents.id });
    return row?.id ?? null;
  }

  async findEvent(id: string): Promise<StoredBillingEvent | null> {
    const [row] = await this.db
      .select({ id: billingEvents.id, type: billingEvents.type, payload: billingEvents.payload, processedAt: billingEvents.processedAt })
      .from(billingEvents)
      .where(eq(billingEvents.id, id));
    return row ?? null;
  }

  async markProcessed(id: string, outcome: string): Promise<void> {
    await this.db
      .update(billingEvents)
      .set({ processedAt: sql`now()`, outcome })
      .where(and(eq(billingEvents.id, id), isNull(billingEvents.processedAt)));
  }

  async grantPurchase(input: { userId: string; credits: number; orderRef: string }): Promise<'granted' | 'duplicate' | 'unknown_user'> {
    try {
      const rows = await this.db
        .insert(creditLedger)
        .values({ userId: input.userId, delta: input.credits, reason: 'purchase', externalRef: input.orderRef })
        .onConflictDoNothing()
        .returning({ id: creditLedger.id });
      return rows.length > 0 ? 'granted' : 'duplicate';
    } catch (error) {
      if (pgCode(error) === FOREIGN_KEY_VIOLATION) return 'unknown_user';
      throw error;
    }
  }

  async findPurchase(orderRef: string): Promise<{ userId: string; credits: number } | null> {
    const [row] = await this.db
      .select({ userId: creditLedger.userId, credits: creditLedger.delta })
      .from(creditLedger)
      .where(and(eq(creditLedger.reason, 'purchase'), eq(creditLedger.externalRef, orderRef)));
    // A deleted account's purchase is anonymised (user_id null): there is no balance left to claw back from.
    return row?.userId ? { userId: row.userId, credits: row.credits } : null;
  }

  applyRefund(
    input: { userId: string; orderRef: string },
    decide: (state: { balance: number; alreadyClawedBack: number }) => { target: number; delta: number },
  ): Promise<'applied' | 'duplicate'> {
    return this.db.transaction(async (tx) => {
      await lockUser(tx, input.userId);
      const balance = await balanceOf(tx, input.userId);
      const [prior] = await tx
        .select({ taken: sql<number>`coalesce(-sum(${creditLedger.delta}), 0)::int` })
        .from(creditLedger)
        .where(and(eq(creditLedger.reason, 'refund'), like(creditLedger.externalRef, `${input.orderRef}:refund:%`)));
      const { target, delta } = decide({ balance, alreadyClawedBack: prior?.taken ?? 0 });
      // One row per order and cumulative target: a replayed refund event writes nothing.
      const rows = await tx
        .insert(creditLedger)
        .values({ userId: input.userId, delta, reason: 'refund', externalRef: `${input.orderRef}:refund:${target}` })
        .onConflictDoNothing()
        .returning({ id: creditLedger.id });
      return rows.length > 0 ? 'applied' : 'duplicate';
    });
  }

  upsertSubscription(input: {
    userId: string;
    subscriptionId: string;
    orderId: string;
    entitlement: Entitlement;
    providerUpdatedAt: Date;
    now: Date;
  }): Promise<'applied' | 'stale' | 'other_subscription' | 'unknown_user'> {
    return this.db
      .transaction(async (tx) => {
        await lockUser(tx, input.userId);
        const [current] = await tx
          .select({ providerUpdatedAt: entitlements.providerUpdatedAt, subscriptionId: entitlements.providerSubscriptionId, periodEnd: entitlements.periodEnd })
          .from(entitlements)
          .where(eq(entitlements.userId, input.userId));
        if (current?.subscriptionId === input.subscriptionId) {
          // Webhooks can arrive out of order; the same subscription only moves forward in provider time.
          if (current.providerUpdatedAt && current.providerUpdatedAt >= input.providerUpdatedAt) return 'stale' as const;
        } else if (current?.subscriptionId && current.periodEnd > input.now && input.entitlement.periodEnd <= current.periodEnd) {
          // A second subscription that grants no more than the running one leaves it untouched.
          return 'other_subscription' as const;
        }
        const values = {
          plan: input.entitlement.plan,
          monthlyPathQuota: input.entitlement.monthlyPathQuota,
          periodStart: input.entitlement.periodStart,
          periodEnd: input.entitlement.periodEnd,
          providerSubscriptionId: input.subscriptionId,
          providerOrderId: input.orderId,
          providerUpdatedAt: input.providerUpdatedAt,
        };
        await tx
          .insert(entitlements)
          .values({ userId: input.userId, ...values })
          .onConflictDoUpdate({ target: entitlements.userId, set: { ...values, updatedAt: sql`now()` } });
        return 'applied' as const;
      })
      .catch((error: unknown) => {
        if (pgCode(error) === FOREIGN_KEY_VIOLATION) return 'unknown_user' as const;
        throw error;
      });
  }

  async endSubscription(subscriptionId: string, entitlement: Entitlement): Promise<string | null> {
    const [row] = await this.db
      .update(entitlements)
      .set({ periodStart: entitlement.periodStart, periodEnd: entitlement.periodEnd, updatedAt: sql`now()` })
      .where(eq(entitlements.providerSubscriptionId, subscriptionId))
      .returning({ userId: entitlements.userId });
    return row?.userId ?? null;
  }

  async endSubscriptionForOrder(orderId: string, entitlement: Entitlement): Promise<string | null> {
    const [row] = await this.db
      .update(entitlements)
      .set({ periodStart: entitlement.periodStart, periodEnd: entitlement.periodEnd, updatedAt: sql`now()` })
      .where(eq(entitlements.providerOrderId, orderId))
      .returning({ userId: entitlements.userId });
    return row?.userId ?? null;
  }

  reservePath(input: { userId: string; pathRef: string }, decide: (state: LockedQuotaState) => Promise<PathCharge>): Promise<PathCharge> {
    return this.db.transaction(async (tx) => {
      await lockUser(tx, input.userId);
      const externalRef = `path:${input.pathRef}`;
      const [earlier] = await tx
        .select({ delta: creditLedger.delta })
        .from(creditLedger)
        .where(and(eq(creditLedger.reason, 'path'), eq(creditLedger.externalRef, externalRef)));
      if (earlier) return earlier.delta === 0 ? 'plan' : 'credit';

      const [entitlement] = await tx
        .select({ plan: entitlements.plan, monthlyPathQuota: entitlements.monthlyPathQuota, periodStart: entitlements.periodStart, periodEnd: entitlements.periodEnd })
        .from(entitlements)
        .where(eq(entitlements.userId, input.userId));
      const charge = await decide({
        entitlement: entitlement ?? null,
        balance: await balanceOf(tx, input.userId),
        usedPathsBetween: async (from, to) => {
          const [row] = await tx
            .select({ n: sql<number>`count(*)::int` })
            .from(creditLedger)
            .where(planCoveredPaths(input.userId, from, to));
          return row?.n ?? 0;
        },
      });
      if (charge === 'exceeded') return charge;
      await tx.insert(creditLedger).values({ userId: input.userId, delta: charge === 'plan' ? 0 : -1, reason: 'path', externalRef });
      return charge;
    });
  }

  refundPath(input: { userId: string; pathRef: string }): Promise<'refunded' | 'duplicate' | 'not_charged'> {
    return this.db.transaction(async (tx) => {
      await lockUser(tx, input.userId);
      const externalRef = `path:${input.pathRef}`;
      const [charge] = await tx
        .select({ delta: creditLedger.delta })
        .from(creditLedger)
        .where(and(eq(creditLedger.userId, input.userId), eq(creditLedger.reason, 'path'), eq(creditLedger.externalRef, externalRef)));
      if (!charge) return 'not_charged';
      const written = await tx
        .insert(creditLedger)
        .values({ userId: input.userId, delta: -charge.delta, reason: 'refund', externalRef })
        .onConflictDoNothing()
        .returning({ id: creditLedger.id });
      return written.length > 0 ? 'refunded' : 'duplicate';
    });
  }
}

/** Serialises one learner's ledger changes for the rest of the transaction. */
async function lockUser(tx: Tx, userId: string): Promise<void> {
  await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`billing:${userId}`}, 0))`);
}

async function balanceOf(tx: Tx, userId: string): Promise<number> {
  const [row] = await tx
    .select({ balance: sql<number>`coalesce(sum(${creditLedger.delta}), 0)::int` })
    .from(creditLedger)
    .where(eq(creditLedger.userId, userId));
  return row?.balance ?? 0;
}
