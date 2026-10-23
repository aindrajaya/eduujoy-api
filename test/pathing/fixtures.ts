import { randomUUID } from 'node:crypto';
import { diagnosticSessions, placements } from '../../src/shared/db/schema/assessment';
import { topics } from '../../src/shared/db/schema/catalog';
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
