import { bigserial, index, integer, jsonb, pgEnum, pgTable, text, timestamp, uniqueIndex, uuid } from 'drizzle-orm/pg-core';
import { withCreatedAt, withUpdatedAt } from '../common';
import { users } from '../identity';

export const jobStatus = pgEnum('job_status', ['queued', 'running', 'succeeded', 'failed', 'dead']);

/** Durable jobs; written in the same transaction as the state change, so it doubles as the outbox. */
export const jobs = pgTable(
  'jobs',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    type: text('type').notNull(),
    idempotencyKey: text('idempotency_key').notNull(),
    userId: uuid('user_id').references(() => users.id, { onDelete: 'set null' }),
    payload: jsonb('payload').notNull(),
    status: jobStatus('status').notNull().default('queued'),
    progress: jsonb('progress'),
    attempts: integer('attempts').notNull().default(0),
    maxAttempts: integer('max_attempts').notNull().default(3),
    runAfter: timestamp('run_after', { withTimezone: true }).notNull().defaultNow(),
    lockedAt: timestamp('locked_at', { withTimezone: true }),
    result: jsonb('result'),
    error: text('error'),
    ...withCreatedAt,
    ...withUpdatedAt,
  },
  (t) => [
    uniqueIndex('jobs_idempotency_key').on(t.idempotencyKey),
    index('jobs_status_run_after_idx').on(t.status, t.runAfter),
    index('jobs_user_idx').on(t.userId),
  ],
);

export const jobEventType = pgEnum('job_event_type', ['progress', 'partial', 'completed', 'failed']);

/**
 * Append-only event log per job (PRD-API §9). The bigserial id is the SSE event id, so a reconnect
 * replays everything after Last-Event-ID.
 */
export const jobEvents = pgTable(
  'job_events',
  {
    id: bigserial('id', { mode: 'number' }).primaryKey(),
    jobId: uuid('job_id')
      .notNull()
      .references(() => jobs.id, { onDelete: 'cascade' }),
    type: jobEventType('type').notNull(),
    data: jsonb('data').notNull(),
    ...withCreatedAt,
  },
  (t) => [index('job_events_job_id_idx').on(t.jobId, t.id)],
);

