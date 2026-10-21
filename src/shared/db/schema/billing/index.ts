import { sql } from 'drizzle-orm';
import { index, integer, jsonb, pgEnum, pgTable, text, timestamp, uniqueIndex, uuid } from 'drizzle-orm/pg-core';
import { plan, withCreatedAt, withUpdatedAt } from '../common';
import { users } from '../identity';

export const creditReason = pgEnum('credit_reason', ['purchase', 'path', 'refund']);

export const entitlements = pgTable('entitlements', {
  userId: uuid('user_id')
    .primaryKey()
    .references(() => users.id, { onDelete: 'cascade' }),
  plan: plan('plan').notNull().default('free'),
  monthlyPathQuota: integer('monthly_path_quota').notNull(),
  periodStart: timestamp('period_start', { withTimezone: true }).notNull(),
  periodEnd: timestamp('period_end', { withTimezone: true }).notNull(),
  providerSubscriptionId: text('provider_subscription_id'),
  /** The provider's `updated_at` of the last applied subscription event; older, out-of-order events are skipped. */
  providerUpdatedAt: timestamp('provider_updated_at', { withTimezone: true }),
  ...withUpdatedAt,
}, (t) => [index('entitlements_provider_subscription_idx').on(t.providerSubscriptionId)]);

/** Signed credit movements; the balance is SUM(delta). `external_ref` makes purchases idempotent. */
export const creditLedger = pgTable(
  'credit_ledger',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    delta: integer('delta').notNull(),
    reason: creditReason('reason').notNull(),
    externalRef: text('external_ref'),
    ...withCreatedAt,
  },
  (t) => [
    index('credit_ledger_user_idx').on(t.userId, t.createdAt),
    uniqueIndex('credit_ledger_reason_external_ref_key')
      .on(t.reason, t.externalRef)
      .where(sql`${t.externalRef} is not null`),
  ],
);

export const billingEvents = pgTable(
  'billing_events',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    providerEventId: text('provider_event_id').notNull(),
    type: text('type').notNull(),
    payload: jsonb('payload').notNull(),
    ...withCreatedAt,
    processedAt: timestamp('processed_at', { withTimezone: true }),
    /** What processing did (`credited`, `ignored:mode_mismatch`, ...), for audit and support. */
    outcome: text('outcome'),
  },
  (t) => [uniqueIndex('billing_events_provider_event_id_key').on(t.providerEventId)],
);
