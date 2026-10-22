import { Inject, Injectable } from '@nestjs/common';
import { and, asc, cosineDistance, desc, eq, gt, inArray, isNotNull, isNull, lt, ne, or, sql } from 'drizzle-orm';
import { DATABASE, type Database, type Tx } from '../../../shared/db';
import { discoveryResults, resourceCards, resources } from '../../../shared/db/schema/discovery';
import {
  type CardRecord,
  type DiscoveryRepository,
  type NewCard,
  type NewResource,
  type PoolCard,
  type PoolRecord,
  type ResourceRecord,
} from '../application/ports/discovery.repository';
import { type CardStatus, type PoolStatus, type Stage } from '../domain';

const POOL = {
  id: discoveryResults.id,
  topicId: discoveryResults.topicId,
  stage: discoveryResults.stage,
  poolVersion: discoveryResults.poolVersion,
  status: discoveryResults.status,
  candidateIds: discoveryResults.candidateIds,
  analysedIds: discoveryResults.analysedIds,
  resourceIds: discoveryResults.resourceIds,
  videoFallback: discoveryResults.videoFallback,
  expiresAt: discoveryResults.expiresAt,
};

const RESOURCE = {
  id: resources.id,
  url: resources.url,
  type: resources.type,
  title: resources.title,
  source: resources.source,
  youtubeId: resources.youtubeId,
  durationMin: resources.durationMin,
  failedChecks: resources.failedChecks,
  deadAt: resources.deadAt,
  metadataFetchedAt: resources.metadataFetchedAt,
};

const CARD = { id: resourceCards.id, resourceId: resourceCards.resourceId, status: resourceCards.status, qualityScore: resourceCards.qualityScore };

@Injectable()
export class DrizzleDiscoveryRepository implements DiscoveryRepository {
  constructor(@Inject(DATABASE) private readonly db: Database) {}

  async latestPool(topicId: string, stage: Stage): Promise<PoolRecord | null> {
    const [row] = await this.db
      .select(POOL)
      .from(discoveryResults)
      .where(and(eq(discoveryResults.topicId, topicId), eq(discoveryResults.stage, stage)))
      .orderBy(desc(discoveryResults.poolVersion))
      .limit(1);
    return row ?? null;
  }

  async findPool(topicId: string, stage: Stage, poolVersion: number): Promise<PoolRecord | null> {
    const [row] = await this.db
      .select(POOL)
      .from(discoveryResults)
      .where(and(eq(discoveryResults.topicId, topicId), eq(discoveryResults.stage, stage), eq(discoveryResults.poolVersion, poolVersion)));
    return row ?? null;
  }

  async createPool(
    tx: Tx,
    input: { topicId: string; stage: Stage; poolVersion: number; candidateIds: string[]; videoFallback: boolean; expiresAt: Date },
  ): Promise<PoolRecord> {
    const [created] = await tx.insert(discoveryResults).values(input).onConflictDoNothing().returning(POOL);
    if (created) return created;
    const [existing] = await tx
      .select(POOL)
      .from(discoveryResults)
      .where(and(eq(discoveryResults.topicId, input.topicId), eq(discoveryResults.stage, input.stage), eq(discoveryResults.poolVersion, input.poolVersion)));
    if (!existing) throw new Error('Pool insert conflicted but no pool was found');
    return existing;
  }

  async upsertResources(tx: Tx, rows: NewResource[]): Promise<Map<string, string>> {
    const ids = new Map<string, string>();
    for (const row of rows) {
      const values = {
        url: row.url,
        type: row.type,
        title: row.title,
        source: row.source,
        youtubeId: row.youtubeId ?? null,
        durationMin: row.durationMin ?? null,
        publishedAt: row.publishedAt ?? null,
        language: row.language ?? 'en',
        pageAge: row.pageAge ?? null,
        metadataFetchedAt: row.metadataFetchedAt ?? null,
        httpStatus: row.httpStatus ?? null,
        lastCheckedAt: row.checkedAt ?? null,
      };
      // A known URL keeps its id and analysis; fresh metadata and a passing check update it.
      const [saved] = await tx
        .insert(resources)
        .values(values)
        .onConflictDoUpdate({
          target: resources.url,
          set: {
            title: values.title,
            source: values.source,
            ...(row.metadataFetchedAt ? { durationMin: values.durationMin, publishedAt: values.publishedAt, metadataFetchedAt: values.metadataFetchedAt } : {}),
            ...(row.checkedAt ? { httpStatus: values.httpStatus, lastCheckedAt: values.lastCheckedAt, failedChecks: 0 } : {}),
            updatedAt: sql`now()`,
          },
          // A dead resource stays dead; it is not revived by a new discovery.
          setWhere: isNull(resources.deadAt),
        })
        .returning({ id: resources.id });
      const id = saved?.id ?? (await tx.select({ id: resources.id }).from(resources).where(eq(resources.url, row.url)))[0]?.id;
      if (id) ids.set(row.url, id);
    }
    return ids;
  }

  async getResource(id: string): Promise<ResourceRecord | null> {
    const [row] = await this.db.select(RESOURCE).from(resources).where(eq(resources.id, id));
    return row ?? null;
  }

  async findCard(resourceId: string, topicId: string, promptVersion: string, now: Date): Promise<CardRecord | null> {
    const [row] = await this.db
      .select(CARD)
      .from(resourceCards)
      .where(
        and(
          eq(resourceCards.resourceId, resourceId),
          eq(resourceCards.topicId, topicId),
          eq(resourceCards.promptVersion, promptVersion),
          gt(resourceCards.expiresAt, now),
        ),
      );
    return row ?? null;
  }

  async nearestServedCard(topicId: string, vector: number[], excludeResourceId: string): Promise<{ card: CardRecord; similarity: number } | null> {
    const distance = cosineDistance(resourceCards.embedding, vector);
    const [row] = await this.db
      .select({ ...CARD, distance: sql<number>`${distance}` })
      .from(resourceCards)
      .where(
        and(
          eq(resourceCards.topicId, topicId),
          eq(resourceCards.status, 'served'),
          isNotNull(resourceCards.embedding),
          ne(resourceCards.resourceId, excludeResourceId),
        ),
      )
      .orderBy(distance)
      .limit(1);
    if (!row) return null;
    const { distance: d, ...card } = row;
    return { card, similarity: 1 - d };
  }

  async saveCard(tx: Tx, card: NewCard): Promise<string> {
    const values = {
      resourceId: card.resourceId,
      topicId: card.topicId,
      model: card.model,
      promptVersion: card.promptVersion,
      dreyfusStage: card.dreyfusStage,
      bloomLevels: card.bloomLevels,
      prerequisites: card.prerequisites,
      concepts: card.concepts,
      keyTakeaways: card.keyTakeaways,
      whyThis: card.whyThis,
      quality: card.quality,
      qualityScore: card.qualityScore,
      confidence: card.confidence,
      evidence: card.evidence,
      status: card.status,
      reviewReason: card.reviewReason,
      embedding: card.embedding?.vector ?? null,
      embeddingModel: card.embedding?.model ?? null,
      embeddingVersion: card.embedding?.version ?? null,
      expiresAt: card.expiresAt,
    };
    const [row] = await tx
      .insert(resourceCards)
      .values(values)
      .onConflictDoUpdate({
        target: [resourceCards.resourceId, resourceCards.topicId, resourceCards.promptVersion],
        set: { ...values, createdAt: sql`now()` },
      })
      .returning({ id: resourceCards.id });
    if (!row) throw new Error('Card upsert returned no row');
    return row.id;
  }

  async setCardStatus(tx: Tx, cardId: string, status: CardStatus, reason: string | null): Promise<void> {
    await tx.update(resourceCards).set({ status, reviewReason: reason }).where(eq(resourceCards.id, cardId));
  }

  async recordAnalysis(tx: Tx, resourceId: string, fields: { readingMin: number | null; language: string }): Promise<void> {
    await tx
      .update(resources)
      .set({ readingMin: fields.readingMin, language: fields.language, updatedAt: sql`now()` })
      .where(eq(resources.id, resourceId));
  }

  async markAnalysed(tx: Tx, poolId: string, resourceId: string): Promise<PoolRecord | null> {
    // The row lock orders concurrent analyse jobs: exactly one sees the last id appended.
    const [row] = await tx
      .update(discoveryResults)
      .set({ analysedIds: sql`array_append(${discoveryResults.analysedIds}, ${resourceId}::uuid)` })
      .where(and(eq(discoveryResults.id, poolId), sql`not (${resourceId}::uuid = any(${discoveryResults.analysedIds}))`))
      .returning(POOL);
    return row ?? null;
  }

  poolCards(tx: Tx, pool: PoolRecord, promptVersion: string): Promise<PoolCard[]> {
    if (pool.candidateIds.length === 0) return Promise.resolve([]);
    return tx
      .select({ resourceId: resourceCards.resourceId, type: resources.type, status: resourceCards.status, qualityScore: resourceCards.qualityScore })
      .from(resourceCards)
      .innerJoin(resources, eq(resources.id, resourceCards.resourceId))
      .where(
        and(
          inArray(resourceCards.resourceId, pool.candidateIds),
          eq(resourceCards.topicId, pool.topicId),
          eq(resourceCards.promptVersion, promptVersion),
          isNull(resources.deadAt),
        ),
      );
  }

  async settlePool(tx: Tx, poolId: string, status: Exclude<PoolStatus, 'analysing'>, resourceIds: string[], expiresAt: Date): Promise<void> {
    await tx.update(discoveryResults).set({ status, resourceIds, expiresAt }).where(eq(discoveryResults.id, poolId));
  }

  async dueForLiveness(before: Date, limit: number): Promise<string[]> {
    const rows = await this.db
      .select({ id: resources.id })
      .from(resources)
      .where(and(isNull(resources.deadAt), or(isNull(resources.lastCheckedAt), lt(resources.lastCheckedAt, before))))
      .orderBy(sql`${resources.lastCheckedAt} asc nulls first`, asc(resources.id))
      .limit(limit);
    return rows.map((r) => r.id);
  }

  async saveLiveness(resourceId: string, check: { httpStatus: number | null; failedChecks: number; dead: boolean; at: Date }): Promise<boolean> {
    const [row] = await this.db
      .update(resources)
      .set({
        httpStatus: check.httpStatus,
        failedChecks: check.failedChecks,
        lastCheckedAt: check.at,
        ...(check.dead ? { deadAt: check.at } : {}),
        updatedAt: sql`now()`,
      })
      .where(and(eq(resources.id, resourceId), isNull(resources.deadAt)))
      .returning({ deadAt: resources.deadAt });
    return Boolean(check.dead && row?.deadAt);
  }

  async refreshVideo(resourceId: string, video: { title: string; source: string; durationMin: number; publishedAt: string | null; at: Date }): Promise<void> {
    await this.db
      .update(resources)
      .set({ title: video.title, source: video.source, durationMin: video.durationMin, publishedAt: video.publishedAt, metadataFetchedAt: video.at, updatedAt: sql`now()` })
      .where(eq(resources.id, resourceId));
  }
}
