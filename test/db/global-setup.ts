import { Client } from 'pg';
import { runMigrations } from '../../src/shared/db/migrate';
import { readDatabaseEnv } from './database-env';
import { sweepStaleTestSchemas } from './sweep';
import { assertSafeTestDatabase, isTestSchema, newTestSchemaName } from './test-database';

/** Jest globalSetup: a fresh, migrated schema per run on the Neon test branch. */
export default async function globalSetup(): Promise<void> {
  const env = readDatabaseEnv();
  assertSafeTestDatabase(env.test, [env.app, env.direct]);
  const testUrl = env.test as string;

  const schema = newTestSchemaName();
  const client = new Client({ connectionString: testUrl });
  try {
    await client.connect();
    await sweepStaleTestSchemas(client);
    if (!isTestSchema(schema)) throw new Error(`Generated an invalid test schema name: ${schema}`);
    await runMigrations(client, { schema });
  } finally {
    await client.end();
  }

  // Workers inherit these; the app and repositories then use the run's schema.
  process.env['DATABASE_URL'] = testUrl;
  process.env['DATABASE_URL_DIRECT'] = testUrl;
  process.env['DATABASE_SCHEMA'] = schema;
  process.env['EDUUJOY_TEST_SCHEMA'] = schema;
}
