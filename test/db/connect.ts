import { Client } from 'pg';
import { createDatabase, type Database } from '../../src/shared/db/database';
import { guardConnection } from '../../src/shared/db/cli/guard';

export type TestDb = Database;

export function testSchema(): string {
  const name = process.env['EDUUJOY_TEST_SCHEMA'];
  if (!name) throw new Error('EDUUJOY_TEST_SCHEMA is not set; run through the integration Jest config.');
  return name;
}

const CONNECT_ATTEMPTS = 3;
const TRANSIENT = /ECONNRESET|ETIMEDOUT|EADDRNOTAVAIL|ECONNREFUSED|Connection terminated|timeout/i;

/**
 * A direct client whose search_path is the run's schema, with public for pgvector. Test-only resilience
 * for the Neon test branch over flaky networks: a connect timeout (instead of hanging a hook for 30 s),
 * TCP keep-alive, and up to 3 connect attempts on transient errors. Production pool settings are
 * unchanged (src/shared/db/db.module.ts). Queries are never retried: they may not be idempotent.
 */
export async function connectTestClient(schemaName = testSchema()): Promise<Client> {
  for (let attempt = 1; ; attempt++) {
    // Guarded: a Neon drop on a test client must fail that test, not kill the whole Jest worker.
    const client = guardConnection(
      new Client({
        connectionString: process.env['DATABASE_URL'],
        options: `-c search_path="${schemaName}",public`,
        connectionTimeoutMillis: 10_000,
        keepAlive: true,
      }),
      'test-db',
    );
    try {
      await client.connect();
      return client;
    } catch (error) {
      await client.end().catch(() => undefined);
      if (attempt >= CONNECT_ATTEMPTS || !TRANSIENT.test(error instanceof Error ? error.message : String(error))) throw error;
      await new Promise((resolve) => setTimeout(resolve, 500 * attempt));
    }
  }
}

export function testDb(client: Client): TestDb {
  return createDatabase(client);
}
