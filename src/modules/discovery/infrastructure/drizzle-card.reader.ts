import { Inject, Injectable } from '@nestjs/common';
import { and, desc, eq, inArray, isNull } from 'drizzle-orm';
import { DATABASE, type Database } from '../../../shared/db';
import { discoveryResults, resourceCards, resources } from '../../../shared/db/schema/discovery';
import { type CardReader, type PoolSnapshot, type ServedCard } from '../application/ports/card.reader';
import { type Concept, type Quality, type Stage } from '../domain';

@Injectable()
export class DrizzleCardReader implements CardReader {
  constructor(@Inject(DATABASE) private readonly db: Database) {}

  async latestPool(topicId: string, stage: Stage): Promise<PoolSnapshot | null> {
    const [row] = await this.db
      .select({
        id: discoveryResults.id,
        status: discoveryResults.status,
        poolVersion: discoveryResults.poolVersion,
        expiresAt: discoveryResults.expiresAt,
        candidateIds: discoveryResults.candidateIds,
        analysedIds: discoveryResults.analysedIds,
        resourceIds: discoveryResults.resourceIds,
      })
      .from(discoveryResults)
      .where(and(eq(discoveryResults.topicId, topicId), eq(discoveryResults.stage, stage)))
      .orderBy(desc(discoveryResults.poolVersion))
      .limit(1);
    if (!row) return null;
    const { candidateIds, analysedIds, ...rest } = row;
    return { ...rest, candidates: candidateIds.length, analysed: analysedIds.length };
  }

  async cards(topicId: string, resourceIds: string[], includeDead: boolean): Promise<ServedCard[]> {
    if (resourceIds.length === 0) return [];
    // The latest card per resource for this topic (any prompt version; a path keeps showing what it cited).
    const rows = await this.db
      .selectDistinctOn([resources.id], {
        resourceId: resources.id,
        type: resources.type,
        url: resources.url,
        youtubeId: resources.youtubeId,
        title: resources.title,
        source: resources.source,
        durationMin: resources.durationMin,
        readingMin: resources.readingMin,
        published: resources.publishedAt,
        language: resources.language,
        stage: resourceCards.dreyfusStage,
        bloomLevels: resourceCards.bloomLevels,
        prerequisites: resourceCards.prerequisites,
        concepts: resourceCards.concepts,
        keyTakeaways: resourceCards.keyTakeaways,
        whyThis: resourceCards.whyThis,
        quality: resourceCards.quality,
        qualityScore: resourceCards.qualityScore,
      })
      .from(resources)
      .innerJoin(resourceCards, and(eq(resourceCards.resourceId, resources.id), eq(resourceCards.topicId, topicId)))
      .where(and(inArray(resources.id, resourceIds), includeDead ? undefined : isNull(resources.deadAt)))
      .orderBy(resources.id, desc(resourceCards.createdAt));
    const byId = new Map(rows.map((r) => [r.resourceId, { ...r, concepts: r.concepts as Concept[], quality: r.quality as Quality }]));
    return resourceIds.flatMap((id) => (byId.has(id) ? [byId.get(id) as ServedCard] : []));
  }
}
