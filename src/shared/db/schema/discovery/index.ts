import { sql } from 'drizzle-orm';
import {
  boolean,
  check,
  date,
  index,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  primaryKey,
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
/**
 * `served` cards can appear in paths; `review` waits for a human (confidence < 0.7 or a bad timestamp,
 * master PRD §12); `dropped` scored under 60 (FR-11); `duplicate` lost the cosine ≥ 0.95 dedupe.
 */
export const resourceCardStatus = pgEnum('resource_card_status', ['served', 'review', 'dropped', 'duplicate']);
/** `thin` pools finished analysing with fewer than 3 served resource types. */
export const discoveryPoolStatus = pgEnum('discovery_pool_status', ['analysing', 'ready', 'thin']);

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
    /** Web search `page_age` as returned (free text such as "April 30, 2025"). */
    pageAge: text('page_age'),
    httpStatus: integer('http_status'),
    lastCheckedAt: timestamp('last_checked_at', { withTimezone: true }),
    /** Consecutive failed liveness checks; two in a row mark the resource dead. */
    failedChecks: integer('failed_checks').notNull().default(0),
    deadAt: timestamp('dead_at', { withTimezone: true }),
    /** When YouTube metadata was last fetched; it is refreshed or deleted within 30 days (III.E.4). */
    metadataFetchedAt: timestamp('metadata_fetched_at', { withTimezone: true }),
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
    /** The analyser's overall confidence in its stage and Bloom tags (0–1). */
    confidence: real('confidence').notNull(),
    /** Transcript excerpt or section heading that supports the tags (mandatory, master PRD §12). */
    evidence: text('evidence').notNull(),
    status: resourceCardStatus('status').notNull(),
    reviewReason: text('review_reason'),
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
    check('resource_cards_confidence_range', sql`${t.confidence} between 0 and 1`),
  ],
);

/**
 * Discovery result sets per topic and stage, shared across learners (30-day L2 cache, PRD-API §10).
 * `candidate_ids` are the resources found; each analyse job appends to `analysed_ids` once, and the
 * last one fills `resource_ids` with the served resources and settles the status.
 */
export const discoveryResults = pgTable(
  'discovery_results',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    topicId: uuid('topic_id')
      .notNull()
      .references(() => topics.id, { onDelete: 'cascade' }),
    stage: dreyfusStage('stage').notNull(),
    poolVersion: integer('pool_version').notNull(),
    status: discoveryPoolStatus('status').notNull().default('analysing'),
    candidateIds: uuid('candidate_ids').array().notNull().default(sql`'{}'::uuid[]`),
    analysedIds: uuid('analysed_ids').array().notNull().default(sql`'{}'::uuid[]`),
    resourceIds: uuid('resource_ids').array().notNull().default(sql`'{}'::uuid[]`),
    /** True when the YouTube quota guard skipped `search.list` for this pool. */
    videoFallback: boolean('video_fallback').notNull().default(false),
    ...withCreatedAt,
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
  },
  (t) => [uniqueIndex('discovery_results_topic_stage_version_key').on(t.topicId, t.stage, t.poolVersion)],
);

/**
 * Daily calls against a provider quota, keyed by the provider's quota day (YouTube resets at midnight
 * Pacific). `quota` names the bucket, e.g. `youtube.search`.
 */
export const providerQuotaUsage = pgTable(
  'provider_quota_usage',
  {
    quota: text('quota').notNull(),
    day: date('day').notNull(),
    used: integer('used').notNull().default(0),
    ...withUpdatedAt,
  },
  (t) => [primaryKey({ columns: [t.quota, t.day] })],
);
