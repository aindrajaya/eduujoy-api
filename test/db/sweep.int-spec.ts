import { type Client } from 'pg';
import { connectTestClient, testSchema } from './connect';
import { sweepStaleTestSchemas } from './sweep';
import { newTestSchemaName } from './test-database';

describe('sweepStaleTestSchemas (integration)', () => {
  let client: Client;

  beforeAll(async () => {
    client = await connectTestClient();
  });

  afterAll(async () => {
    await client.end();
  });

  const exists = async (name: string): Promise<boolean> => {
    const { rows } = await client.query('SELECT 1 FROM pg_namespace WHERE nspname = $1', [name]);
    return rows.length === 1;
  };

  it('drops test schemas older than 24 hours and keeps recent ones, including this run', async () => {
    const old = newTestSchemaName(new Date(Date.now() - 25 * 60 * 60 * 1000));
    const recent = newTestSchemaName(new Date(Date.now() - 60 * 60 * 1000));
    await client.query(`CREATE SCHEMA "${old}"`);
    await client.query(`CREATE SCHEMA "${recent}"`);
    try {
      const dropped = await sweepStaleTestSchemas(client);

      expect(dropped).toContain(old);
      expect(await exists(old)).toBe(false);
      expect(await exists(recent)).toBe(true);
      expect(await exists(testSchema())).toBe(true);
    } finally {
      await client.query(`DROP SCHEMA IF EXISTS "${old}" CASCADE`);
      await client.query(`DROP SCHEMA IF EXISTS "${recent}" CASCADE`);
    }
  });
});
