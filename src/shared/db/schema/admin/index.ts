import { index, jsonb, pgEnum, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core';
import { withCreatedAt } from '../common';
import { users } from '../identity';

export const reviewKind = pgEnum('review_kind', ['diagnostic_item', 'resource', 'path', 'learner_report']);
export const reviewStatus = pgEnum('review_status', ['open', 'resolved']);
export const reviewResolution = pgEnum('review_resolution', ['approved', 'rejected', 'edited']);

export const reviewItems = pgTable(
  'review_items',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    kind: reviewKind('kind').notNull(),
    targetId: uuid('target_id').notNull(),
    reason: text('reason').notNull(),
    detail: jsonb('detail'),
    status: reviewStatus('status').notNull().default('open'),
    resolution: reviewResolution('resolution'),
    note: text('note'),
    resolvedBy: uuid('resolved_by').references(() => users.id, { onDelete: 'set null' }),
    ...withCreatedAt,
    resolvedAt: timestamp('resolved_at', { withTimezone: true }),
  },
  (t) => [
    index('review_items_status_created_idx').on(t.status, t.createdAt),
    index('review_items_target_idx').on(t.kind, t.targetId),
  ],
);
