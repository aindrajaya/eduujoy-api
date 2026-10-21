import { index, integer, numeric, pgEnum, pgTable, text, uuid } from 'drizzle-orm/pg-core';
import { withCreatedAt } from '../common';
import { jobs } from '../jobs';

export const llmProvider = pgEnum('llm_provider', ['anthropic', 'google']);
export const llmCallStatus = pgEnum('llm_call_status', ['ok', 'error', 'timeout', 'invalid_output', 'refused']);

/** One row per model call; feeds the cost and latency dashboards (FR-25). Pruned after 90 days. */
export const llmCalls = pgTable(
  'llm_calls',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    stage: text('stage').notNull(),
    provider: llmProvider('provider').notNull(),
    model: text('model').notNull(),
    promptName: text('prompt_name'),
    promptVersion: text('prompt_version'),
    inputTokens: integer('input_tokens').notNull().default(0),
    outputTokens: integer('output_tokens').notNull().default(0),
    cacheReadTokens: integer('cache_read_tokens').notNull().default(0),
    costUsd: numeric('cost_usd', { precision: 12, scale: 6 }).notNull().default('0'),
    latencyMs: integer('latency_ms').notNull(),
    status: llmCallStatus('status').notNull(),
    /** AiFailure detail when status is not ok (rate_limited, billing, bad_request, ...). */
    failure: text('failure'),
    jobId: uuid('job_id').references(() => jobs.id, { onDelete: 'set null' }),
    ...withCreatedAt,
  },
  (t) => [
    index('llm_calls_created_idx').on(t.createdAt),
    index('llm_calls_stage_model_idx').on(t.stage, t.model, t.createdAt),
  ],
);
