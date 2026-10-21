import { cosineDistance, getTableName, is, sql } from 'drizzle-orm';
import { PgTable } from 'drizzle-orm/pg-core';
import { type Client } from 'pg';
import { NonEmptySchemaError, runMigrations } from '../../src/shared/db/migrate';
import * as schema from '../../src/shared/db/schema';
import { topicPrerequisites, topics } from '../../src/shared/db/schema';
import { connectTestClient, testDb, testSchema } from './connect';
import { newTestSchemaName } from './test-database';

const tableNames = (Object.values(schema) as unknown[])
  .filter((value): value is PgTable => is(value, PgTable))
  .map((table) => getTableName(table))
  .sort();

function unitVector(hot: number): number[] {
  return Array.from({ length: 768 }, (_, i) => (i === hot ? 1 : 0));
}

describe('migrations (integration)', () => {
  let client: Client;

  beforeAll(async () => {
    client = await connectTestClient();
  });

  afterAll(async () => {
    await client.end();
  });

  it('creates every Drizzle table in the run schema', async () => {
    const { rows } = await client.query<{ table_name: string }>(
      "SELECT table_name FROM information_schema.tables WHERE table_schema = $1 AND table_type = 'BASE TABLE'",
      [testSchema()],
    );

    expect(tableNames.length).toBeGreaterThanOrEqual(25);
    expect(rows.map((row) => row.table_name).sort()).toEqual([...tableNames, '__eduujoy_migrations'].sort());
  });

  it('keeps pgvector in public and builds HNSW cosine indexes on topics and resource_cards', async () => {
    const ext = await client.query<{ schema: string }>(
      "SELECT n.nspname AS schema FROM pg_extension e JOIN pg_namespace n ON n.oid = e.extnamespace WHERE e.extname = 'vector'",
    );
    const idx = await client.query<{ indexname: string; indexdef: string }>(
      "SELECT indexname, indexdef FROM pg_indexes WHERE schemaname = $1 AND indexdef ILIKE '%USING hnsw%' ORDER BY 1",
      [testSchema()],
    );

    expect(ext.rows).toEqual([{ schema: 'public' }]);
    expect(idx.rows.map((row) => row.indexname)).toEqual([
      'resource_cards_embedding_hnsw_idx',
      'topics_embedding_hnsw_idx',
    ]);
    expect(idx.rows.every((row) => row.indexdef.includes('vector_cosine_ops'))).toBe(true);
  });

  it('is a no-op when run again', async () => {
    await expect(runMigrations(client, { schema: testSchema() })).resolves.toEqual([]);
  });

  it('refuses a schema that already has tables but no migration ledger', async () => {
    const foreign = newTestSchemaName();
    await client.query(`CREATE SCHEMA "${foreign}"`);
    await client.query(`CREATE TABLE "${foreign}"."_prisma_migrations" (id text)`);
    try {
      await expect(runMigrations(client, { schema: foreign })).rejects.toBeInstanceOf(NonEmptySchemaError);
    } finally {
      await client.query(`DROP SCHEMA "${foreign}" CASCADE`);
    }
  });

  it('ranks topics by cosine similarity through the vector column', async () => {
    const db = testDb(client);
    const query = unitVector(0);
    await db.insert(topics).values([
      { slug: 'int-near', canonicalName: 'Near', embedding: unitVector(0) },
      { slug: 'int-mid', canonicalName: 'Mid', embedding: query.map((v, i) => (i === 1 ? 1 : v)) },
      { slug: 'int-far', canonicalName: 'Far', embedding: unitVector(2) },
    ]);

    const similarity = sql<number>`1 - (${cosineDistance(topics.embedding, query)})`;
    const rows = await db
      .select({ slug: topics.slug, similarity })
      .from(topics)
      .where(sql`${topics.slug} like 'int-%'`)
      .orderBy(cosineDistance(topics.embedding, query))
      .limit(2);

    expect(rows.map((row) => row.slug)).toEqual(['int-near', 'int-mid']);
    expect(rows[0]?.similarity).toBeCloseTo(1, 5);
    expect(rows[1]?.similarity).toBeCloseTo(Math.SQRT1_2, 5);
  });

  it('uses the HNSW index for nearest-neighbour ordering', async () => {
    await client.query('BEGIN');
    try {
      await client.query('SET LOCAL enable_seqscan = off');
      const { rows } = await client.query<{ 'QUERY PLAN': string }>(
        `EXPLAIN SELECT id FROM topics ORDER BY embedding <=> $1::vector LIMIT 3`,
        [`[${unitVector(0).join(',')}]`],
      );
      expect(rows.map((row) => row['QUERY PLAN']).join('\n')).toContain('topics_embedding_hnsw_idx');
    } finally {
      await client.query('ROLLBACK');
    }
  });

  it('enforces check constraints such as no self-prerequisite', async () => {
    const db = testDb(client);
    const [topic] = await db.insert(topics).values({ slug: 'int-self', canonicalName: 'Self' }).returning();
    const id = topic?.id ?? '';

    await expect(db.insert(topicPrerequisites).values({ topicId: id, prerequisiteId: id })).rejects.toThrow();
  });
});
