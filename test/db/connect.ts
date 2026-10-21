import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres';
import { Client } from 'pg';
import * as schema from '../../src/shared/db/schema';

export type TestDb = NodePgDatabase<typeof schema>;

export function testSchema(): string {
  const name = process.env['EDUUJOY_TEST_SCHEMA'];
  if (!name) throw new Error('EDUUJOY_TEST_SCHEMA is not set; run through the integration Jest config.');
  return name;
}

/** A direct client whose search_path is the run's schema, with public for pgvector. */
export async function connectTestClient(schemaName = testSchema()): Promise<Client> {
  const client = new Client({
    connectionString: process.env['DATABASE_URL'],
    options: `-c search_path="${schemaName}",public`,
  });
  await client.connect();
  return client;
}

export function testDb(client: Client): TestDb {
  return drizzle(client, { schema, casing: 'snake_case' });
}
