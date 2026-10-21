import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';

export interface Migration {
  tag: string;
  hash: string;
  statements: string[];
}
export interface AppliedMigration {
  tag: string;
  hash: string;
}

export class MigrationDriftError extends Error {
  override name = 'MigrationDriftError';
}

const SCHEMA_NAME = /^[a-z_][a-z0-9_]{0,62}$/;
const BREAKPOINT = '--> statement-breakpoint';

const journalSchema = z.object({
  entries: z.array(z.object({ idx: z.number().int(), tag: z.string().regex(/^\d{4}_[a-z0-9_]+$/) })),
});

export function assertSchemaName(name: string): void {
  if (!SCHEMA_NAME.test(name)) throw new Error(`Invalid schema name: ${JSON.stringify(name)}`);
}

export function splitStatements(sql: string): string[] {
  return sql
    .split(BREAKPOINT)
    .map((chunk) => chunk.trim())
    .filter((chunk) => chunk.length > 0);
}

/** drizzle-kit qualifies types and FK targets with "public"; point them at the target schema. */
export function retargetSql(sql: string, schema: string): string {
  assertSchemaName(schema);
  return schema === 'public' ? sql : sql.replaceAll('"public".', `"${schema}".`);
}

export function readMigrations(dir: string): Migration[] {
  const journal = journalSchema.parse(JSON.parse(readFileSync(join(dir, 'meta', '_journal.json'), 'utf8')));
  return [...journal.entries]
    .sort((a, b) => a.idx - b.idx)
    .map(({ tag }) => {
      const sql = readFileSync(join(dir, `${tag}.sql`), 'utf8');
      return { tag, hash: createHash('sha256').update(sql).digest('hex'), statements: splitStatements(sql) };
    });
}

/** Pending migrations in order; refuses edited or unknown applied migrations instead of guessing. */
export function planMigrations(all: Migration[], applied: AppliedMigration[]): Migration[] {
  const known = new Map(all.map((m) => [m.tag, m]));
  for (const row of applied) {
    const migration = known.get(row.tag);
    if (!migration) throw new MigrationDriftError(`Database has unknown migration ${row.tag}`);
    if (migration.hash !== row.hash) throw new MigrationDriftError(`Migration ${row.tag} changed after it was applied`);
  }
  const done = new Set(applied.map((row) => row.tag));
  return all.filter((m) => !done.has(m.tag));
}
