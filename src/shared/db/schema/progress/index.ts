import { sql } from 'drizzle-orm';
import { check, index, pgEnum, pgTable, real, text, uuid } from 'drizzle-orm/pg-core';
import { topics } from '../catalog';
import { bloomLevel, dreyfusStage, positionSource, withCreatedAt } from '../common';
import { users } from '../identity';

export const feedbackTargetType = pgEnum('feedback_target_type', ['resource', 'step']);
// Master PRD §9 lists `swap`; the contract adds `flag`. Both are stored.
export const feedbackKind = pgEnum('feedback_kind', ['up', 'down', 'swap', 'too_easy', 'too_hard', 'flag']);

/** Append-only position history; the current position is the latest row per (user, topic). */
export const learnerPositions = pgTable(
  'learner_positions',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    topicId: uuid('topic_id')
      .notNull()
      .references(() => topics.id),
    stage: dreyfusStage('stage').notNull(),
    bloom: bloomLevel('bloom').notNull(),
    confidence: real('confidence').notNull(),
    source: positionSource('source').notNull(),
    ...withCreatedAt,
  },
  (t) => [
    index('learner_positions_user_topic_created_idx').on(t.userId, t.topicId, t.createdAt.desc()),
    check('learner_positions_confidence_range', sql`${t.confidence} between 0 and 1`),
  ],
);

export const feedbackEvents = pgTable(
  'feedback_events',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    targetType: feedbackTargetType('target_type').notNull(),
    targetId: uuid('target_id').notNull(),
    kind: feedbackKind('kind').notNull(),
    comment: text('comment'),
    ...withCreatedAt,
  },
  (t) => [
    index('feedback_events_target_idx').on(t.targetType, t.targetId),
    index('feedback_events_user_idx').on(t.userId, t.createdAt),
  ],
);
