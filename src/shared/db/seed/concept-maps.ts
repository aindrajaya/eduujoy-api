import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { and, eq, inArray, sql } from 'drizzle-orm';
import { type ConceptMap, conceptMapSchema } from '../../common/concept-map';
import { type Database } from '../database';
import { topicConceptMaps, topics } from '../schema/catalog';

/**
 * The concept maps (user, 3 Nov 2026): seed/concept-maps/<slug>.json, one per seed topic, validated
 * here as on read. Files starting with `_` (provenance) are not maps. A missing directory means none.
 */
export function readConceptMaps(dir: string): { slug: string; map: ConceptMap }[] {
  const mapsDir = join(dir, 'concept-maps');
  if (!existsSync(mapsDir)) return [];
  const problems: string[] = [];
  const maps: { slug: string; map: ConceptMap }[] = [];
  for (const file of readdirSync(mapsDir).filter((name) => name.endsWith('.json') && !name.startsWith('_')).sort()) {
    const slug = basename(file, '.json');
    const parsed = conceptMapSchema.safeParse(JSON.parse(readFileSync(join(mapsDir, file), 'utf8')));
    if (!parsed.success) {
      for (const issue of parsed.error.issues.slice(0, 3)) problems.push(`concept-maps/${file} ${issue.path.join('.')}: ${issue.message}`);
      continue;
    }
    if (parsed.data.topic !== slug) problems.push(`concept-maps/${file}: topic "${parsed.data.topic}" does not match the file name`);
    else maps.push({ slug, map: parsed.data });
  }
  if (problems.length > 0) throw new Error(`Invalid concept maps:\n${problems.join('\n')}`);
  return maps;
}

/**
 * Upserts each map onto its seed topic, in one transaction (a savepoint under db:seed --dry-run).
 * Additive: a map that left the files keeps its row (lead, 3 Nov 2026), and a map for a slug that is
 * not a seed topic refuses the whole load.
 */
export async function loadConceptMaps(db: Database, maps: { slug: string; map: ConceptMap }[]): Promise<{ loaded: number; changed: number }> {
  if (maps.length === 0) return { loaded: 0, changed: 0 };
  return db.transaction(async (tx) => {
    const rows = await tx
      .select({ id: topics.id, slug: topics.slug })
      .from(topics)
      .where(
        and(
          inArray(
            topics.slug,
            maps.map((m) => m.slug),
          ),
          eq(topics.origin, 'seed'),
        ),
      );
    const ids = new Map(rows.map((r) => [r.slug, r.id]));
    const unknown = maps.filter((m) => !ids.has(m.slug)).map((m) => m.slug);
    if (unknown.length > 0) throw new Error(`Concept maps for topics that are not seed topics: ${unknown.slice(0, 10).join(', ')}`);
    let changed = 0;
    for (const { slug, map } of maps) {
      const written = await tx
        .insert(topicConceptMaps)
        .values({ topicId: ids.get(slug) as string, version: map.version, promptVersion: map.promptVersion ?? 'unknown', map })
        .onConflictDoUpdate({
          target: topicConceptMaps.topicId,
          set: { version: sql`excluded.version`, promptVersion: sql`excluded.prompt_version`, map: sql`excluded.map`, updatedAt: sql`now()` },
          // Unchanged maps are left alone, so the count says what a run really changed.
          setWhere: sql`${topicConceptMaps.map} is distinct from excluded.map`,
        })
        .returning({ id: topicConceptMaps.topicId });
      changed += written.length;
    }
    return { loaded: maps.length, changed };
  });
}
