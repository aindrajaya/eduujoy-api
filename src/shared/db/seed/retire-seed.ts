import { sql } from 'drizzle-orm';
import { type Database } from '../database';
import { type DbExecutor } from '../transaction';

/** A seed item that is no longer in the seed files: its row, topic and every reference found. */
export interface RetireCandidate {
  id: string;
  seedKey: string;
  topic: string;
  /** diagnostic_answers rows (the only foreign key into diagnostic_items). */
  answers: number;
  /** Rows of other tables whose jsonb or array columns contain the item id (session state, replays, caches). */
  heldBy: Record<string, number>;
}

export interface RetireResult {
  candidates: RetireCandidate[];
  referenced: RetireCandidate[];
  deleted: number;
  /** Why nothing was deleted: a dry run, references found, or a foreign-key violation (rolled back). */
  outcome: 'dry_run' | 'deleted' | 'refused_referenced' | 'rolled_back_fk' | 'nothing_to_do';
}

class Rollback extends Error {
  override name = 'Rollback';
}

const FOREIGN_KEY_VIOLATION = '23503';

function pgCode(error: unknown): string | undefined {
  const own = (error as { code?: unknown }).code;
  const cause = (error as { cause?: { code?: unknown } }).cause?.code;
  return typeof own === 'string' ? own : typeof cause === 'string' ? cause : undefined;
}

/**
 * Items whose seed_key is gone from the seed files, on seed topics only: learner-topic items (A14) and
 * items without a seed_key are never candidates. Locked FOR UPDATE until the transaction ends.
 */
async function lockCandidates(tx: DbExecutor, seedKeys: string[]): Promise<{ id: string; seedKey: string; topic: string }[]> {
  const result = await tx.execute<{ id: string; seed_key: string; slug: string }>(sql`
    SELECT i.id, i.seed_key, t.slug
      FROM diagnostic_items i JOIN topics t ON t.id = i.topic_id
     WHERE t.origin = 'seed' AND i.seed_key IS NOT NULL AND NOT (i.seed_key = ANY(${sql.param(seedKeys)}::text[]))
     ORDER BY t.slug, i.seed_key
       FOR UPDATE OF i`);
  return result.rows.map((r) => ({ id: r.id, seedKey: r.seed_key, topic: r.slug }));
}

/**
 * Every place an item id can sit without a foreign key (lead gate, 2 Nov 2026): each jsonb, uuid[] or
 * text[] column of the schema except diagnostic_items' own, e.g. diagnostic_sessions.state (served and
 * current items) and diagnostic_answer_replays.response. Discovered from the catalog, so a future cache
 * column is checked without a code change.
 */
async function nonKeyReferences(tx: DbExecutor, ids: string[]): Promise<Map<string, Record<string, number>>> {
  const held = new Map<string, Record<string, number>>(ids.map((id) => [id, {}]));
  if (ids.length === 0) return held;
  const columns = await tx.execute<{ table_name: string; column_name: string }>(sql`
    SELECT table_name, column_name FROM information_schema.columns
     WHERE table_schema = current_schema() AND table_name <> 'diagnostic_items'
       AND (data_type = 'jsonb' OR (data_type = 'ARRAY' AND udt_name IN ('_uuid', '_text')))`);
  const pattern = ids.join('|');
  for (const { table_name: table, column_name: column } of columns.rows) {
    const rows = await tx.execute<{ text: string }>(
      sql`SELECT ${sql.identifier(column)}::text AS text FROM ${sql.identifier(table)} WHERE ${sql.identifier(column)}::text ~ ${pattern}`,
    );
    for (const { text } of rows.rows) {
      for (const id of ids) {
        if (!text.includes(id)) continue;
        const counts = held.get(id) ?? {};
        const key = `${table}.${column}`;
        counts[key] = (counts[key] ?? 0) + 1;
        held.set(id, counts);
      }
    }
  }
  return held;
}

/**
 * Removes seed items that are no longer in the seed files (`seedKeys` = every key in the files), in one
 * transaction with the candidates locked. Any reference, by foreign key or held in another table's
 * jsonb or arrays, means nothing is deleted. A dry run (the default) always rolls back.
 */
export async function retireSeedItems(db: Database, seedKeys: string[], options: { apply: boolean }): Promise<RetireResult> {
  let result: RetireResult = { candidates: [], referenced: [], deleted: 0, outcome: 'nothing_to_do' };
  try {
    await db.transaction(async (tx) => {
      const rows = await lockCandidates(tx, seedKeys);
      const ids = rows.map((r) => r.id);
      const answers = new Map<string, number>();
      if (ids.length > 0) {
        const counted = await tx.execute<{ item_id: string; n: number }>(
          sql`SELECT item_id, count(*)::int AS n FROM diagnostic_answers WHERE item_id = ANY(${sql.param(ids)}::uuid[]) GROUP BY item_id`,
        );
        for (const r of counted.rows) answers.set(r.item_id, r.n);
      }
      const held = await nonKeyReferences(tx, ids);
      const candidates = rows.map((r) => ({ ...r, answers: answers.get(r.id) ?? 0, heldBy: held.get(r.id) ?? {} }));
      const referenced = candidates.filter((c) => c.answers > 0 || Object.keys(c.heldBy).length > 0);
      result = { candidates, referenced, deleted: 0, outcome: candidates.length === 0 ? 'nothing_to_do' : 'dry_run' };
      if (candidates.length === 0) return;
      if (referenced.length > 0) {
        result.outcome = 'refused_referenced';
        throw new Rollback();
      }
      if (!options.apply) throw new Rollback();
      const deleted = await tx.execute(sql`DELETE FROM diagnostic_items WHERE id = ANY(${sql.param(ids)}::uuid[])`);
      result = { ...result, deleted: deleted.rowCount ?? 0, outcome: 'deleted' };
    });
  } catch (error) {
    if (error instanceof Rollback) return result;
    // An answer written after the lock (it can't be: the FK check waits on the row lock), or any FK.
    if (pgCode(error) === FOREIGN_KEY_VIOLATION) return { ...result, deleted: 0, outcome: 'rolled_back_fk' };
    throw error;
  }
  return result;
}

/** Candidates per topic, for the CLI's summary. */
export function countsByTopic(candidates: RetireCandidate[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const c of candidates) out[c.topic] = (out[c.topic] ?? 0) + 1;
  return out;
}
