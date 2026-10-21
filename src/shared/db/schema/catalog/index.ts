import { sql } from 'drizzle-orm';
import {
  type AnyPgColumn,
  boolean,
  check,
  index,
  integer,
  pgEnum,
  pgTable,
  primaryKey,
  text,
  uniqueIndex,
  uuid,
  vector,
} from 'drizzle-orm/pg-core';
import { EMBEDDING_DIMENSIONS, withCreatedAt, withUpdatedAt } from '../common';
import { users } from '../identity';

export const topicDomain = pgEnum('topic_domain', ['software', 'stem', 'non_technical']);
export const topicOrigin = pgEnum('topic_origin', ['seed', 'learner', 'reviewer']);

export const topics = pgTable(
  'topics',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    slug: text('slug').notNull(),
    canonicalName: text('canonical_name').notNull(),
    aliases: text('aliases').array().notNull().default(sql`'{}'::text[]`),
    description: text('description'),
    domain: topicDomain('domain'),
    parentId: uuid('parent_id').references((): AnyPgColumn => topics.id, { onDelete: 'set null' }),
    origin: topicOrigin('origin').notNull().default('seed'),
    /** The learner whose text created the topic (FR-02 create path); caps creates per user and day. */
    createdBy: uuid('created_by').references(() => users.id, { onDelete: 'set null' }),
    /** Created without the normaliser or without an embedding; a reviewer checks the name and domain. */
    needsReview: boolean('needs_review').notNull().default(false),
    embedding: vector('embedding', { dimensions: EMBEDDING_DIMENSIONS }),
    embeddingModel: text('embedding_model'),
    embeddingVersion: integer('embedding_version'),
    ...withCreatedAt,
    ...withUpdatedAt,
  },
  (t) => [
    uniqueIndex('topics_slug_key').on(t.slug),
    index('topics_parent_id_idx').on(t.parentId),
    index('topics_created_by_idx').on(t.createdBy, t.createdAt),
    index('topics_embedding_hnsw_idx').using('hnsw', t.embedding.op('vector_cosine_ops')),
  ],
);

/** Prerequisite edges from the seed taxonomy: `topicId` requires `prerequisiteId`. */
export const topicPrerequisites = pgTable(
  'topic_prerequisites',
  {
    topicId: uuid('topic_id')
      .notNull()
      .references(() => topics.id, { onDelete: 'cascade' }),
    prerequisiteId: uuid('prerequisite_id')
      .notNull()
      .references(() => topics.id, { onDelete: 'cascade' }),
  },
  (t) => [
    primaryKey({ columns: [t.topicId, t.prerequisiteId] }),
    index('topic_prerequisites_prerequisite_idx').on(t.prerequisiteId),
    check('topic_prerequisites_no_self_edge', sql`${t.topicId} <> ${t.prerequisiteId}`),
  ],
);
