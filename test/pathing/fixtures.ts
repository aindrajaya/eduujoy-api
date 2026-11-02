import { randomUUID } from 'node:crypto';
import { diagnosticSessions, placements } from '../../src/shared/db/schema/assessment';
import { topics } from '../../src/shared/db/schema/catalog';
import { discoveryResults, resourceCards, resources } from '../../src/shared/db/schema/discovery';
import { users } from '../../src/shared/db/schema/identity';
import { type TestDb } from '../db/connect';

type Db = TestDb;
type Stage = 'novice' | 'advanced_beginner' | 'competent' | 'proficient' | 'expert';
type Bloom = 'C1' | 'C2' | 'C3' | 'C4' | 'C5' | 'C6';

export async function learner(db: Db): Promise<string> {
  const [row] = await db.insert(users).values({ email: `path-${randomUUID()}@example.com` }).returning({ id: users.id });
  return row?.id ?? '';
}

export async function topic(db: Db): Promise<string> {
  const tag = randomUUID().slice(0, 8);
  const [row] = await db.insert(topics).values({ slug: `path-${tag}`, canonicalName: `Path topic ${tag}`, domain: 'software' }).returning({ id: topics.id });
  return row?.id ?? '';
}

/** A completed diagnostic and its placement for `userId` on `topicId`. */
export async function placement(db: Db, userId: string, topicId: string, at: { stage: Stage; bloom: Bloom } = { stage: 'advanced_beginner', bloom: 'C3' }, weeklyHours = 4): Promise<string> {
  const [session] = await db
    .insert(diagnosticSessions)
    .values({ userId, topicId, goal: 'Build a dashboard at work', weeklyHours, preferredFormats: ['video'], status: 'completed' })
    .returning({ id: diagnosticSessions.id });
  const [row] = await db
    .insert(placements)
    .values({ sessionId: session?.id ?? '', userId, topicId, stage: at.stage, bloom: at.bloom, confidence: 0.8, reason: 'test' })
    .returning({ id: placements.id });
  return row?.id ?? '';
}

const RESOURCE_TYPES = ['youtube', 'article', 'official_doc', 'paper'] as const;

/** A ready, unexpired pool for (topic, stage) with `n` served cards of rotating types. */
export async function readyPool(db: Db, topicId: string, stage: Stage, n = 4): Promise<string[]> {
  const ids: string[] = [];
  for (let i = 0; i < n; i += 1) {
    const type = RESOURCE_TYPES[i % RESOURCE_TYPES.length] ?? 'article';
    const [row] = await db
      .insert(resources)
      .values({
        url: `https://example.com/${randomUUID()}`,
        type,
        title: `${stage} resource ${i + 1}`,
        source: 'example.com',
        durationMin: type === 'youtube' ? 12 : null,
        readingMin: type === 'youtube' ? null : 8,
      })
      .returning({ id: resources.id });
    const id = row?.id ?? '';
    await db.insert(resourceCards).values({
      resourceId: id,
      topicId,
      model: 'fake',
      promptVersion: 'v1',
      dreyfusStage: stage,
      bloomLevels: ['C2', 'C3'],
      concepts: [],
      keyTakeaways: ['A takeaway.'],
      quality: { relevance: 80, accuracySignals: 80, recency: 80, teaching: 80 },
      qualityScore: 80,
      confidence: 0.9,
      evidence: 'x',
      status: 'served',
      expiresAt: new Date(Date.now() + 86_400_000),
    });
    ids.push(id);
  }
  await db.insert(discoveryResults).values({ topicId, stage, poolVersion: 1, status: 'ready', candidateIds: ids, analysedIds: ids, resourceIds: ids, expiresAt: new Date(Date.now() + 86_400_000) });
  return ids;
}
