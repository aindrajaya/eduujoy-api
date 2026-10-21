import { join } from 'node:path';
import { type ClientBase } from 'pg';
import { type AppliedMigration, assertSchemaName, planMigrations, readMigrations, retargetSql } from './migrations';

/** A `pg.Client` or checked-out `pg.PoolClient`; migrations need one session for the lock and SET LOCAL. */
export type SqlClient = Pick<ClientBase, 'query'>;

export const MIGRATIONS_DIR = join(__dirname, '..', '..', '..', 'drizzle');
const LEDGER = '__eduujoy_migrations';

export class NonEmptySchemaError extends Error {
  override name = 'NonEmptySchemaError';
  constructor(
    readonly schema: string,
    readonly tables: string[],
  ) {
    super(
      `Refusing to migrate: schema "${schema}" has ${tables.length} table(s) but no migration ledger. ` +
        'It may belong to another app; point DATABASE_URL_DIRECT at an empty database.',
    );
  }
}

export interface MigrateOptions {
  schema?: string;
  dir?: string;
}

/** Applies pending migrations into `schema` (default public); returns the tags it applied. */
export async function runMigrations(client: SqlClient, options: MigrateOptions = {}): Promise<string[]> {
  const schema = options.schema ?? 'public';
  assertSchemaName(schema);
  const all = readMigrations(options.dir ?? MIGRATIONS_DIR);

  await client.query('SELECT pg_advisory_lock(hashtext($1))', [`eduujoy:migrate:${schema}`]);
  try {
    if (schema !== 'public') await client.query(`CREATE SCHEMA IF NOT EXISTS "${schema}"`);
    await assertSafeTarget(client, schema);
    await client.query(
      `CREATE TABLE IF NOT EXISTS "${schema}"."${LEDGER}" (
         tag text PRIMARY KEY, hash text NOT NULL, applied_at timestamptz NOT NULL DEFAULT now())`,
    );
    const { rows: applied } = await client.query<AppliedMigration>(
      `SELECT tag, hash FROM "${schema}"."${LEDGER}" ORDER BY tag`,
    );

    const appliedNow: string[] = [];
    for (const migration of planMigrations(all, applied)) {
      await client.query('BEGIN');
      try {
        await client.query(`SET LOCAL search_path TO "${schema}", public`);
        for (const statement of migration.statements) await client.query(retargetSql(statement, schema));
        await client.query(`INSERT INTO "${schema}"."${LEDGER}" (tag, hash) VALUES ($1, $2)`, [
          migration.tag,
          migration.hash,
        ]);
        await client.query('COMMIT');
      } catch (error) {
        await client.query('ROLLBACK');
        throw error;
      }
      appliedNow.push(migration.tag);
    }
    return appliedNow;
  } finally {
    await client.query('SELECT pg_advisory_unlock(hashtext($1))', [`eduujoy:migrate:${schema}`]);
  }
}

/** A schema with tables but no ledger is someone else's data (for example the old Prisma app). */
async function assertSafeTarget(client: SqlClient, schema: string): Promise<void> {
  const { rows } = await client.query<{ table_name: string }>(
    `SELECT table_name FROM information_schema.tables
      WHERE table_schema = $1 AND table_type = 'BASE TABLE' ORDER BY table_name`,
    [schema],
  );
  const tables = rows.map((row) => row.table_name);
  if (tables.length > 0 && !tables.includes(LEDGER)) throw new NonEmptySchemaError(schema, tables);
}
