import { inArray, sql } from 'drizzle-orm';
import { type Database } from '../database';
import { diagnosticItems, topicPrerequisites, topics } from '../schema';
import { retireRefusal, retirementCap, SeedRetireRefusedError } from './retire-policy';
import { type SeedData } from './seed-data';

export interface SeedResult {
  topics: number;
  prerequisites: number;
  items: number;
  /** Seed keys of the items this run retired (no longer in the files), sorted. */
  retired: string[];
  /** Items that were retired and are back in the files (retired_at cleared). */
  restored: number;
}

const CHUNK = 500;

function chunks<T>(rows: T[]): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < rows.length; i += CHUNK) out.push(rows.slice(i, i + CHUNK));
  return out;
}

/**
 * Idempotent: topics upsert by slug and items by seed_key, so re-running converges on the files. Items
 * that left the files are retired (inactive, kept); items that return are active again.
 * Embeddings are left alone; the catalog backfills them (A6).
 */
export async function loadSeed(db: Database, data: SeedData, options: { expectRetired?: number; dryRun?: boolean } = {}): Promise<SeedResult> {
  return db.transaction(async (tx) => {
    const fileKeys = data.items.map((item) => item.seedKey);
    // Retirement only looks at topics that have items in the files: a partial load (the taxonomy plus one
    // topic's bank), a topic left out, or a missing item file never retires another topic's items. A
    // topic's whole bank is therefore never retired by deleting its file (conservative by design).
    const fileTopics = [...new Set(data.items.map((item) => item.topic))];
    // Before any write: the active seed-topic items, and the retired ones the files bring back.
    const before = await tx.execute<{ active: number; restoring: number }>(sql`
      SELECT count(*) FILTER (WHERE i.retired_at IS NULL)::int AS active,
             count(*) FILTER (WHERE i.retired_at IS NOT NULL AND i.seed_key = ANY(${sql.param(fileKeys)}::text[]))::int AS restoring
        FROM diagnostic_items i JOIN topics t ON t.id = i.topic_id
       WHERE t.origin = 'seed' AND i.seed_key IS NOT NULL AND t.slug = ANY(${sql.param(fileTopics)}::text[])`);
    const activeSeedItems = before.rows[0]?.active ?? 0;
    const restored = before.rows[0]?.restoring ?? 0;
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
            // An item back in the files is active again.
            retiredAt: null,
            updatedAt: sql`now()`,
          },
        });
    }

    // Retire, never delete: items of the files' seed topics whose seed_key left the files (learner-topic
    // items and items without a seed_key are out of scope). A refusal rolls back the whole seed.
    const gone = await tx.execute<{ seed_key: string }>(sql`
      SELECT i.seed_key FROM diagnostic_items i JOIN topics t ON t.id = i.topic_id
       WHERE t.origin = 'seed' AND i.seed_key IS NOT NULL AND i.retired_at IS NULL
         AND t.slug = ANY(${sql.param(fileTopics)}::text[])
         AND NOT (i.seed_key = ANY(${sql.param(fileKeys)}::text[]))
       ORDER BY i.seed_key
         FOR UPDATE OF i`);
    const retired = gone.rows.map((r) => r.seed_key);
    const refusal = retireRefusal({ toRetire: retired.length, activeSeedItems, filesItems: fileKeys.length, expectRetired: options.expectRetired, dryRun: options.dryRun });
    if (refusal) {
      throw new SeedRetireRefusedError(refusal, {
        toRetire: retired.length,
        activeSeedItems,
        filesItems: fileKeys.length,
        cap: retirementCap(activeSeedItems),
        expectRetired: options.expectRetired,
        keys: retired,
      });
    }
    if (retired.length > 0) {
      await tx.execute(sql`UPDATE diagnostic_items SET retired_at = now(), updated_at = now() WHERE seed_key = ANY(${sql.param(retired)}::text[]) AND retired_at IS NULL`);
    }

    return { topics: data.topics.length, prerequisites: edges.length, items: data.items.length, retired, restored };
  });
}
