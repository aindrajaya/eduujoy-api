import { sql } from 'drizzle-orm';
import {
  boolean,
  check,
  index,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  real,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import { placements } from '../assessment';
import { topics } from '../catalog';
import { bloomLevel, dreyfusStage, withCreatedAt, withUpdatedAt } from '../common';
import { users } from '../identity';

export const pathStatus = pgEnum('path_status', ['generating', 'active', 'completed', 'failed', 'under_review']);
export const stepStatus = pgEnum('step_status', ['locked', 'active', 'completed', 'skipped']);
export const stepDifficulty = pgEnum('step_difficulty', ['too_easy', 'ok', 'too_hard']);

export const paths = pgTable(
  'paths',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    topicId: uuid('topic_id')
      .notNull()
      .references(() => topics.id),
    placementId: uuid('placement_id').references(() => placements.id, { onDelete: 'set null' }),
    fromStage: dreyfusStage('from_stage').notNull(),
    fromBloom: bloomLevel('from_bloom').notNull(),
    toStage: dreyfusStage('to_stage').notNull(),
    toBloom: bloomLevel('to_bloom').notNull(),
    status: pathStatus('status').notNull().default('generating'),
    goal: text('goal'),
    weeklyHours: real('weekly_hours'),
    model: text('model'),
    promptVersion: text('prompt_version'),
    jobId: uuid('job_id'),
    /** Set once the path's charge is settled: given back, or nothing to give (A9: dead job, rejected or unreviewed for 48 h, wait cap). */
    refundedAt: timestamp('refunded_at', { withTimezone: true }),
    ...withCreatedAt,
    ...withUpdatedAt,
  },
  (t) => [
    index('paths_user_created_idx').on(t.userId, t.createdAt),
    index('paths_topic_idx').on(t.topicId),
    // One live path per placement; a failed (refunded) one may be requested again.
    uniqueIndex('paths_user_placement_live_key')
      .on(t.userId, t.placementId)
      .where(sql`${t.placementId} is not null and ${t.status} <> 'failed'`),
  ],
);

/** `actions` and `checkpoint` hold the contract's camelCase shapes; `resource_ids` keeps step order. */
export const pathSteps = pgTable(
  'path_steps',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    pathId: uuid('path_id')
      .notNull()
      .references(() => paths.id, { onDelete: 'cascade' }),
    n: integer('n').notNull(),
    objective: text('objective').notNull(),
    bloom: bloomLevel('bloom').notNull(),
    actions: jsonb('actions').notNull().default(sql`'[]'::jsonb`),
    resourceIds: uuid('resource_ids').array().notNull(),
    checkpoint: jsonb('checkpoint').notNull(),
    /** Per checkpoint item, in order: `{correctOptionIds, expectedAnswer}`. Server-side only (A10 grades). */
    answerKeys: jsonb('answer_keys').notNull().default(sql`'[]'::jsonb`),
    doneWhen: text('done_when').notNull(),
    estMinutes: integer('est_minutes').notNull(),
    status: stepStatus('status').notNull().default('locked'),
    remedial: boolean('remedial').notNull().default(false),
    difficulty: stepDifficulty('difficulty'),
    ...withCreatedAt,
    ...withUpdatedAt,
  },
  (t) => [
    uniqueIndex('path_steps_path_n_key').on(t.pathId, t.n),
    check('path_steps_n_positive', sql`${t.n} >= 1`),
    check('path_steps_est_minutes_positive', sql`${t.estMinutes} >= 1`),
  ],
);

/**
 * Stored 202 responses of `POST /v1/paths` per `Idempotency-Key` (keys are scoped per user);
 * `request_hash` covers the body, so the same key with another body is 409 IDEMPOTENCY_MISMATCH.
 */
export const pathRequestReplays = pgTable(
  'path_request_replays',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    pathId: uuid('path_id')
      .notNull()
      .references(() => paths.id, { onDelete: 'cascade' }),
    idempotencyKey: text('idempotency_key').notNull(),
    requestHash: text('request_hash').notNull(),
    response: jsonb('response').notNull(),
    ...withCreatedAt,
  },
  (t) => [uniqueIndex('path_request_replays_user_key').on(t.userId, t.idempotencyKey)],
);
