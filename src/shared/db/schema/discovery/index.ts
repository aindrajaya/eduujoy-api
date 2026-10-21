import { sql } from 'drizzle-orm';
import {
  date,
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
  vector,
} from 'drizzle-orm/pg-core';
import { topics } from '../catalog';
import { bloomLevel, dreyfusStage, EMBEDDING_DIMENSIONS, withCreatedAt, withUpdatedAt } from '../common';

export const resourceType = pgEnum('resource_type', ['youtube', 'article', 'official_doc', 'paper', 'related']);

export const resources = pgTable(
  'resources',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    url: text('url').notNull(),
    type: resourceType('type').notNull(),
    title: text('title').notNull(),
    source: text('source').notNull(),
    youtubeId: text('youtube_id'),
    durationMin: integer('duration_min'),
    readingMin: integer('reading_min'),
    publishedAt: date('published_at'),
    language: text('language').notNull().default('en'),
    httpStatus: integer('http_status'),
    lastCheckedAt: timestamp('last_checked_at', { withTimezone: true }),
    deadAt: timestamp('dead_at', { withTimezone: true }),
    ...withCreatedAt,
    ...withUpdatedAt,
  },
  (t) => [uniqueIndex('resources_url_key').on(t.url), index('resources_last_checked_idx').on(t.lastCheckedAt)],
);

/**
 * AI analysis of a resource for one topic and prompt version (the L2 cache, PRD-API §10).
 * `concepts` and `quality` hold the camelCase public shapes; raw transcripts are never stored.
 */
export const resourceCards = pgTable(
  'resource_cards',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    resourceId: uuid('resource_id')
      .notNull()
      .references(() => resources.id, { onDelete: 'cascade' }),
    topicId: uuid('topic_id')
      .notNull()
      .references(() => topics.id, { onDelete: 'cascade' }),
    model: text('model').notNull(),
    promptVersion: text('prompt_version').notNull(),
    dreyfusStage: dreyfusStage('dreyfus_stage').notNull(),
    bloomLevels: bloomLevel('bloom_levels').array().notNull(),
    prerequisites: text('prerequisites').array().notNull().default(sql`'{}'::text[]`),
    concepts: jsonb('concepts').notNull().default(sql`'[]'::jsonb`),
    keyTakeaways: text('key_takeaways').array().notNull().default(sql`'{}'::text[]`),
    whyThis: text('why_this'),
    quality: jsonb('quality').notNull(),
    qualityScore: real('quality_score').notNull(),
    embedding: vector('embedding', { dimensions: EMBEDDING_DIMENSIONS }),
    embeddingModel: text('embedding_model'),
    embeddingVersion: integer('embedding_version'),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    ...withCreatedAt,
  },
  (t) => [
    uniqueIndex('resource_cards_resource_topic_prompt_key').on(t.resourceId, t.topicId, t.promptVersion),
    index('resource_cards_topic_stage_idx').on(t.topicId, t.dreyfusStage),
    index('resource_cards_bloom_levels_gin_idx').using('gin', t.bloomLevels),
    index('resource_cards_embedding_hnsw_idx').using('hnsw', t.embedding.op('vector_cosine_ops')),
  ],
);

/** Discovery result sets per topic and stage (7-day L2 cache, PRD-API §10). */
export const discoveryResults = pgTable(
  'discovery_results',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    topicId: uuid('topic_id')
      .notNull()
      .references(() => topics.id, { onDelete: 'cascade' }),
    stage: dreyfusStage('stage').notNull(),
    poolVersion: integer('pool_version').notNull(),
    resourceIds: uuid('resource_ids').array().notNull(),
    ...withCreatedAt,
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
  },
  (t) => [uniqueIndex('discovery_results_topic_stage_version_key').on(t.topicId, t.stage, t.poolVersion)],
);
