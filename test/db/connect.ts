import { Client } from 'pg';
import { createDatabase, type Database } from '../../src/shared/db/database';

export type TestDb = Database;

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
  return createDatabase(client);
}
