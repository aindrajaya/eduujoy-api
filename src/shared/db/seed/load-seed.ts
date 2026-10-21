import { inArray, sql } from 'drizzle-orm';
import { type Database } from '../database';
import { diagnosticItems, topicPrerequisites, topics } from '../schema';
import { type SeedData } from './seed-data';

export interface SeedResult {
  topics: number;
  prerequisites: number;
  items: number;
}

const CHUNK = 500;

function chunks<T>(rows: T[]): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < rows.length; i += CHUNK) out.push(rows.slice(i, i + CHUNK));
  return out;
}

/**
 * Idempotent: topics upsert by slug and items by seed_key, so re-running converges on the files.
 * Embeddings are left alone; the catalog backfills them (A6).
 */
export async function loadSeed(db: Database, data: SeedData): Promise<SeedResult> {
  return db.transaction(async (tx) => {
    const ids = new Map<string, string>();
    for (const batch of chunks(data.topics)) {
      const rows = await tx
        .insert(topics)
        .values(
          batch.map((t) => ({
            slug: t.slug,
            canonicalName: t.canonicalName,
            aliases: t.aliases,
            description: t.description,
            domain: t.domain,
            origin: 'seed' as const,
          })),
        )
        .onConflictDoUpdate({
          target: topics.slug,
          set: {
            canonicalName: sql`excluded.canonical_name`,
            aliases: sql`excluded.aliases`,
            description: sql`excluded.description`,
            domain: sql`excluded.domain`,
            updatedAt: sql`now()`,
          },
        })
        .returning({ id: topics.id, slug: topics.slug });
      for (const row of rows) ids.set(row.slug, row.id);
    }
    const idOf = (slug: string): string => {
      const id = ids.get(slug);
      if (!id) throw new Error(`Seed topic "${slug}" was not upserted`);
      return id;
    };

    const seeded = data.topics.map((t) => idOf(t.slug));
    const parents = data.topics.map((t) => (t.parent === null ? null : idOf(t.parent)));
    await tx.execute(sql`
      UPDATE ${topics} AS t SET parent_id = u.parent_id
      FROM unnest(${sql.param(seeded)}::uuid[], ${sql.param(parents)}::uuid[]) AS u(id, parent_id)
      WHERE t.id = u.id`);

    await tx.delete(topicPrerequisites).where(inArray(topicPrerequisites.topicId, seeded));
    const edges = data.topics.flatMap((t) =>
      t.prerequisites.map((p) => ({ topicId: idOf(t.slug), prerequisiteId: idOf(p) })),
    );
    for (const batch of chunks(edges)) await tx.insert(topicPrerequisites).values(batch);

    for (const batch of chunks(data.items)) {
      await tx
        .insert(diagnosticItems)
        .values(
          batch.map((item) => ({
            topicId: idOf(item.topic),
            seedKey: item.seedKey,
            stage: item.stage,
            bloom: item.bloom,
            kind: item.kind,
            body: { prompt: item.prompt, options: item.options ?? null, answerKey: item.answerKey ?? null },
            rubric: item.rubric ?? null,
            reviewed: item.reviewed,
          })),
        )
        .onConflictDoUpdate({
          target: diagnosticItems.seedKey,
          set: {
            topicId: sql`excluded.topic_id`,
            stage: sql`excluded.stage`,
            bloom: sql`excluded.bloom`,
            kind: sql`excluded.kind`,
            body: sql`excluded.body`,
            rubric: sql`excluded.rubric`,
            reviewed: sql`excluded.reviewed`,
            updatedAt: sql`now()`,
          },
        });
    }

    return { topics: data.topics.length, prerequisites: edges.length, items: data.items.length };
  });
}
