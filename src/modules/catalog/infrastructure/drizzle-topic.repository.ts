import { Inject, Injectable } from '@nestjs/common';
import { and, asc, cosineDistance, eq, gte, isNotNull, ne, or, sql } from 'drizzle-orm';
import { DATABASE, type Database } from '../../../shared/db';
import { topics } from '../../../shared/db/schema/catalog';
import {
  type CreateLimit,
  type CreateResult,
  type NearTopic,
  type NewTopic,
  type TopicEmbedding,
  type TopicRepository,
  type TopicToEmbed,
  type TopicView,
} from '../application/ports/topic.repository';

const VIEW = {
  id: topics.id,
  canonicalName: topics.canonicalName,
  aliases: topics.aliases,
  parentId: topics.parentId,
  description: topics.description,
};

@Injectable()
export class DrizzleTopicRepository implements TopicRepository {
  constructor(@Inject(DATABASE) private readonly db: Database) {}

  async findById(id: string): Promise<TopicView | null> {
    const [row] = await this.db.select(VIEW).from(topics).where(eq(topics.id, id));
    return row ?? null;
  }

  findExact(normalised: string, slug: string): Promise<TopicView[]> {
    return this.db
      .select(VIEW)
      .from(topics)
      .where(
        or(
          eq(topics.slug, slug),
          sql`lower(${topics.canonicalName}) = ${normalised}`,
          sql`exists (select 1 from unnest(${topics.aliases}) as alias where lower(alias) = ${normalised})`,
        ),
      )
      .orderBy(asc(topics.slug))
      .limit(5);
  }

  async nearest(query: TopicEmbedding, limit: number): Promise<NearTopic[]> {
    const distance = cosineDistance(topics.embedding, query.vector);
    const rows = await this.db
      .select({ ...VIEW, distance: sql<number>`${distance}` })
      .from(topics)
      .where(and(isNotNull(topics.embedding), eq(topics.embeddingModel, query.model), eq(topics.embeddingVersion, query.version)))
      // ORDER BY the distance expression so the HNSW cosine index serves the query.
      .orderBy(distance)
      .limit(limit);
    return rows.map(({ distance: d, ...topic }) => ({ topic, similarity: 1 - d }));
  }

  create(topic: NewTopic, limit: CreateLimit): Promise<CreateResult> {
    return this.db.transaction(async (tx) => {
      // Serialises one creator's count + insert, so parallel requests can't pass the daily cap.
      await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`topic-create:${topic.createdBy}`}, 0))`);
      const [count] = await tx
        .select({ n: sql<number>`count(*)::int` })
        .from(topics)
        .where(and(eq(topics.createdBy, topic.createdBy), gte(topics.createdAt, limit.since)));
      if ((count?.n ?? 0) >= limit.max) return { outcome: 'limited' as const };
      const [row] = await tx
      .insert(topics)
      .values({
        slug: topic.slug,
        canonicalName: topic.canonicalName,
        aliases: topic.aliases,
        description: topic.description,
        domain: topic.domain,
        origin: 'learner',
        createdBy: topic.createdBy,
        needsReview: topic.needsReview,
        ...(topic.embedding
          ? { embedding: topic.embedding.vector, embeddingModel: topic.embedding.model, embeddingVersion: topic.embedding.version }
          : {}),
      })
      .onConflictDoNothing({ target: topics.slug })
      .returning(VIEW);
      if (row) return { outcome: 'created' as const, topic: row };
      const [existing] = await tx.select(VIEW).from(topics).where(eq(topics.slug, topic.slug));
      if (!existing) throw new Error(`Topic ${topic.slug} vanished during create`);
      return { outcome: 'exists' as const, topic: existing };
    });
  }

  async countCreatedBy(userId: string, since: Date): Promise<number> {
    const [row] = await this.db
      .select({ n: sql<number>`count(*)::int` })
      .from(topics)
      .where(and(eq(topics.createdBy, userId), gte(topics.createdAt, since)));
    return row?.n ?? 0;
  }

  listUnembedded(model: string, version: number, limit: number): Promise<TopicToEmbed[]> {
    return this.db
      .select({ id: topics.id, canonicalName: topics.canonicalName, aliases: topics.aliases, description: topics.description })
      .from(topics)
      .where(
        or(
          sql`${topics.embedding} is null`,
          sql`${topics.embeddingModel} is distinct from ${model}`,
          ne(sql`coalesce(${topics.embeddingVersion}, -1)`, version),
        ),
      )
      .orderBy(asc(topics.createdAt), asc(topics.id))
      .limit(limit);
  }

  async setEmbedding(id: string, embedding: TopicEmbedding): Promise<void> {
    await this.db
      .update(topics)
      .set({ embedding: embedding.vector, embeddingModel: embedding.model, embeddingVersion: embedding.version })
      .where(eq(topics.id, id));
  }
}
