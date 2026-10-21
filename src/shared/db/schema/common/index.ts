import { pgEnum, timestamp } from 'drizzle-orm/pg-core';

// Value sets shared by several modules. Names and values mirror the frozen contract
// (docs/contract/openapi.v0.yaml); the DB stores the same snake_case literals the API returns.
export const dreyfusStage = pgEnum('dreyfus_stage', [
  'novice',
  'advanced_beginner',
  'competent',
  'proficient',
  'expert',
]);
export const bloomLevel = pgEnum('bloom_level', ['C1', 'C2', 'C3', 'C4', 'C5', 'C6']);
export const plan = pgEnum('plan', ['free', 'subscription']);
export const resourceFormat = pgEnum('resource_format', ['video', 'text', 'papers']);
export const positionSource = pgEnum('position_source', ['diagnostic', 'checkpoint', 'override']);

// Spread into tables (Drizzle's reusable-columns pattern).
export const withCreatedAt = {
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
};
export const withUpdatedAt = {
  updatedAt: timestamp('updated_at', { withTimezone: true })
    .notNull()
    .defaultNow()
    .$onUpdate(() => new Date()),
};

/** Vector width for every embedding column (gemini-embedding-2 with output_dimensionality 768). */
export const EMBEDDING_DIMENSIONS = 768;
