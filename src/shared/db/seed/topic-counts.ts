import { sql } from 'drizzle-orm';
import { type DbExecutor } from '../transaction';
import { topics } from '../schema';

export interface TopicCounts {
  /** Topics the seed owns (origin 'seed'); what `db:seed --expect-topics` checks. */
  seed: number;
  /** Everything else: learner-created and reviewer topics, legitimate in prod. */
  other: number;
}

export async function topicCounts(db: DbExecutor): Promise<TopicCounts> {
  const [row] = await db
    .select({
      seed: sql<number>`count(*) filter (where ${topics.origin} = 'seed')::int`,
      other: sql<number>`count(*) filter (where ${topics.origin} <> 'seed')::int`,
    })
    .from(topics);
  return { seed: row?.seed ?? 0, other: row?.other ?? 0 };
}
