import { Inject, Injectable } from '@nestjs/common';
import { and, asc, eq, inArray, like, or, sql } from 'drizzle-orm';
import { type AccountDataContributor } from '../../../shared/common/account';
import { DATABASE, type Database, type Tx } from '../../../shared/db';
import { billingEvents, creditLedger, entitlements } from '../../../shared/db/schema/billing';

/**
 * Personal fields in stored Lemon Squeezy webhook payloads (order, subscription and invoice
 * attributes), removed on account deletion. Ids (order, subscription, customer) and amounts stay for
 * refund and fraud handling; `urls` goes too because it holds signed customer-portal links.
 */
export const STRIPPED_PAYLOAD_PATHS = [
  ['data', 'attributes', 'user_name'],
  ['data', 'attributes', 'user_email'],
  ['data', 'attributes', 'card_brand'],
  ['data', 'attributes', 'card_last_four'],
  ['data', 'attributes', 'billing_address'],
  ['data', 'attributes', 'tax_number'],
  ['data', 'attributes', 'urls'],
] as const;

/**
 * Plan, credit ledger and billing history. On deletion (user decision, 22 Oct 2026) the ledger and the
 * webhook events stay, re-keyed to a random tombstone id with personal fields stripped; the
 * entitlement row is deleted with the user.
 */
@Injectable()
export class BillingAccountData implements AccountDataContributor {
  readonly section = 'billing';

  constructor(@Inject(DATABASE) private readonly db: Database) {}

  async export(userId: string): Promise<unknown> {
    const [entitlement] = await this.db
      .select({ plan: entitlements.plan, monthlyPathQuota: entitlements.monthlyPathQuota, periodStart: entitlements.periodStart, periodEnd: entitlements.periodEnd })
      .from(entitlements)
      .where(eq(entitlements.userId, userId));
    const ledger = await this.db
      .select({ delta: creditLedger.delta, reason: creditLedger.reason, createdAt: creditLedger.createdAt })
      .from(creditLedger)
      .where(eq(creditLedger.userId, userId))
      .orderBy(asc(creditLedger.createdAt));
    return { entitlement: entitlement ?? null, creditLedger: ledger };
  }

  async erase(tx: Tx, userId: string, tombstone: string): Promise<void> {
    // The provider ids that tie webhook events to this learner, besides our user id in custom data.
    const orderIds = (
      await tx
        .select({ ref: creditLedger.externalRef })
        .from(creditLedger)
        .where(and(eq(creditLedger.userId, userId), like(creditLedger.externalRef, 'ls-order:%')))
    )
      .map((r) => /^ls-order:(\d+)/.exec(r.ref ?? '')?.[1])
      .filter((id): id is string => id !== undefined);
    const [sub] = await tx
      .select({ subscriptionId: entitlements.providerSubscriptionId, orderId: entitlements.providerOrderId })
      .from(entitlements)
      .where(eq(entitlements.userId, userId));
    const subscriptionIds = sub?.subscriptionId ? [sub.subscriptionId] : [];
    if (sub?.orderId) orderIds.push(sub.orderId);

    let stripped = sql`${billingEvents.payload}`;
    for (const path of STRIPPED_PAYLOAD_PATHS) stripped = sql`(${stripped} #- ${`{${path.join(',')}}`}::text[])`;
    const owned = [
      sql`${billingEvents.payload} -> 'meta' -> 'custom_data' ->> 'user_id' = ${userId}`,
      ...(orderIds.length > 0
        ? [
            and(sql`${billingEvents.payload} -> 'data' ->> 'type' = 'orders'`, inArray(sql`${billingEvents.payload} -> 'data' ->> 'id'`, orderIds)),
            inArray(sql`${billingEvents.payload} -> 'data' -> 'attributes' ->> 'order_id'`, orderIds),
          ]
        : []),
      ...(subscriptionIds.length > 0
        ? [
            and(sql`${billingEvents.payload} -> 'data' ->> 'type' = 'subscriptions'`, inArray(sql`${billingEvents.payload} -> 'data' ->> 'id'`, subscriptionIds)),
            inArray(sql`${billingEvents.payload} -> 'data' -> 'attributes' ->> 'subscription_id'`, subscriptionIds),
          ]
        : []),
    ];
    await tx
      .update(billingEvents)
      .set({
        // Our user id becomes the tombstone only where it was set (jsonb_set with create_missing false).
        payload: sql`jsonb_set(${stripped}, '{meta,custom_data,user_id}', to_jsonb(${tombstone}::text), false)`,
      })
      .where(or(...owned));
    // The ledger rows stay; deleting the user then nulls user_id (ON DELETE SET NULL).
    await tx.update(creditLedger).set({ subjectRef: tombstone }).where(eq(creditLedger.userId, userId));
  }
}
