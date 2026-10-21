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
import { topics } from '../catalog';
import { bloomLevel, dreyfusStage, resourceFormat, withCreatedAt, withUpdatedAt } from '../common';
import { users } from '../identity';
import { pathSteps } from '../pathing';

export const diagnosticItemKind = pgEnum('diagnostic_item_kind', [
  'single_choice',
  'multi_choice',
  'short_answer',
  'scenario',
]);
export const diagnosticStatus = pgEnum('diagnostic_status', ['in_progress', 'completed']);
export const submissionStatus = pgEnum('submission_status', ['queued', 'grading', 'graded', 'failed']);
/** How a placement was reached: graded items, or the self-report alone (no item bank yet). */
export const placementBasis = pgEnum('placement_basis', ['items', 'self_report']);

/** `body` holds { prompt, options?, answerKey? }; answer keys never leave the API. */
export const diagnosticItems = pgTable(
  'diagnostic_items',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    topicId: uuid('topic_id')
      .notNull()
      .references(() => topics.id, { onDelete: 'cascade' }),
    stage: dreyfusStage('stage').notNull(),
    bloom: bloomLevel('bloom').notNull(),
    kind: diagnosticItemKind('kind').notNull(),
    body: jsonb('body').notNull(),
    rubric: jsonb('rubric'),
    reviewed: boolean('reviewed').notNull().default(false),
    seedKey: text('seed_key'),
    ...withCreatedAt,
    ...withUpdatedAt,
  },
  (t) => [
    uniqueIndex('diagnostic_items_seed_key_key').on(t.seedKey),
    index('diagnostic_items_topic_stage_bloom_idx').on(t.topicId, t.stage, t.bloom),
  ],
);

export const diagnosticSessions = pgTable(
  'diagnostic_sessions',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    topicId: uuid('topic_id')
      .notNull()
      .references(() => topics.id),
    goal: text('goal').notNull(),
    weeklyHours: real('weekly_hours').notNull(),
    preferredFormats: resourceFormat('preferred_formats').array().notNull().default(sql`'{}'`),
    selfReport: jsonb('self_report'),
    status: diagnosticStatus('status').notNull().default('in_progress'),
    state: jsonb('state').notNull().default(sql`'{}'::jsonb`),
    ...withCreatedAt,
    completedAt: timestamp('completed_at', { withTimezone: true }),
  },
  (t) => [
    index('diagnostic_sessions_user_idx').on(t.userId, t.createdAt),
    // One in-progress diagnostic per user and topic; a second start resumes it.
    uniqueIndex('diagnostic_sessions_open_key')
      .on(t.userId, t.topicId)
      .where(sql`${t.status} = 'in_progress'`),
  ],
);

export const diagnosticAnswers = pgTable(
  'diagnostic_answers',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    sessionId: uuid('session_id')
      .notNull()
      .references(() => diagnosticSessions.id, { onDelete: 'cascade' }),
    itemId: uuid('item_id')
      .notNull()
      .references(() => diagnosticItems.id),
    answer: jsonb('answer').notNull(),
    skipped: boolean('skipped').notNull().default(false),
    score: integer('score'),
    ...withCreatedAt,
  },
  (t) => [
    uniqueIndex('diagnostic_answers_session_item_key').on(t.sessionId, t.itemId),
    check('diagnostic_answers_score_range', sql`${t.score} between 0 and 100`),
  ],
);

/**
 * Stored 200 responses of `POST /v1/diagnostics/:id/answers` sent with an `Idempotency-Key`
 * (contract 0.3.0-v0). Keys are scoped per user; `request_hash` covers the diagnostic id and body.
 */
export const diagnosticAnswerReplays = pgTable(
  'diagnostic_answer_replays',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    sessionId: uuid('session_id')
      .notNull()
      .references(() => diagnosticSessions.id, { onDelete: 'cascade' }),
    idempotencyKey: text('idempotency_key').notNull(),
    requestHash: text('request_hash').notNull(),
    response: jsonb('response').notNull(),
    ...withCreatedAt,
  },
  (t) => [uniqueIndex('diagnostic_answer_replays_user_key').on(t.userId, t.idempotencyKey)],
);

export const placements = pgTable(
  'placements',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    sessionId: uuid('session_id')
      .notNull()
      .references(() => diagnosticSessions.id, { onDelete: 'cascade' }),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    topicId: uuid('topic_id')
      .notNull()
      .references(() => topics.id),
    stage: dreyfusStage('stage').notNull(),
    bloom: bloomLevel('bloom').notNull(),
    confidence: real('confidence').notNull(),
    reason: text('reason').notNull(),
    /** `self_report` placements are re-placed once the topic has an item bank. */
    basis: placementBasis('basis').notNull().default('items'),
    ...withCreatedAt,
  },
  (t) => [
    uniqueIndex('placements_session_key').on(t.sessionId),
    check('placements_confidence_range', sql`${t.confidence} between 0 and 1`),
  ],
);

/** A learner's batch submission for one step's checkpoint; graded asynchronously by a job. */
export const checkpointSubmissions = pgTable(
  'checkpoint_submissions',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    stepId: uuid('step_id')
      .notNull()
      .references(() => pathSteps.id, { onDelete: 'cascade' }),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    idempotencyKey: text('idempotency_key').notNull(),
    answers: jsonb('answers').notNull(),
    status: submissionStatus('status').notNull().default('queued'),
    score: integer('score'),
    ...withCreatedAt,
    gradedAt: timestamp('graded_at', { withTimezone: true }),
  },
  (t) => [
    uniqueIndex('checkpoint_submissions_idempotency_key').on(t.idempotencyKey),
    index('checkpoint_submissions_step_user_idx').on(t.stepId, t.userId),
    check('checkpoint_submissions_score_range', sql`${t.score} between 0 and 100`),
  ],
);

/** One graded attempt per submission; two failed attempts trigger a remedial step (FR-18). */
export const checkpointAttempts = pgTable(
  'checkpoint_attempts',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    stepId: uuid('step_id')
      .notNull()
      .references(() => pathSteps.id, { onDelete: 'cascade' }),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    submissionId: uuid('submission_id').references(() => checkpointSubmissions.id, {
      onDelete: 'set null',
    }),
    answer: jsonb('answer').notNull(),
    score: integer('score').notNull(),
    passed: boolean('passed').notNull(),
    feedback: jsonb('feedback'),
    misconception: text('misconception'),
    gradedBy: text('graded_by').notNull(),
    ...withCreatedAt,
  },
  (t) => [
    index('checkpoint_attempts_step_user_idx').on(t.stepId, t.userId, t.createdAt),
    check('checkpoint_attempts_score_range', sql`${t.score} between 0 and 100`),
  ],
);
