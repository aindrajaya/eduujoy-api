import { Client } from 'pg';
import { isTestSchema } from './test-database';

export default async function globalTeardown(): Promise<void> {
  const schema = process.env['EDUUJOY_TEST_SCHEMA'];
  const url = process.env['DATABASE_URL'];
  if (!schema || !url || !isTestSchema(schema)) return;

  const client = new Client({ connectionString: url });
  try {
    await client.connect();
    await client.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
  } finally {
    await client.end();
  }
}
