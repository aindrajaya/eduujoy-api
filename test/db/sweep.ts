import { type Client } from 'pg';
import { isTestSchema, staleTestSchemas } from './test-database';

/** Drops test_* schemas older than 24 hours (left by crashed runs); returns their names. */
export async function sweepStaleTestSchemas(client: Client, now = new Date()): Promise<string[]> {
  const { rows } = await client.query<{ name: string }>(
    "SELECT nspname AS name FROM pg_namespace WHERE nspname LIKE 'test\\_%'",
  );
  const stale = staleTestSchemas(
    rows.map((row) => row.name),
    now,
  ).filter(isTestSchema);
  for (const name of stale) await client.query(`DROP SCHEMA "${name}" CASCADE`);
  return stale;
}
