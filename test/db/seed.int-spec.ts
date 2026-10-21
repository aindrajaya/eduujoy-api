import { join } from 'node:path';
import { eq, sql } from 'drizzle-orm';
import { type Client } from 'pg';
import { diagnosticItems, topicPrerequisites, topics } from '../../src/shared/db/schema';
import { loadSeed } from '../../src/shared/db/seed/load-seed';
import { parseSeed, readSeedFiles, type SeedData } from '../../src/shared/db/seed/seed-data';
import { connectTestClient, type TestDb, testDb } from './connect';

const FIXTURE = join(__dirname, '..', 'fixtures', 'seed');

describe('seed loader (integration)', () => {
  let client: Client;
  let db: TestDb;
  let data: SeedData;

  beforeAll(async () => {
    client = await connectTestClient();
    db = testDb(client);
    data = parseSeed(readSeedFiles(FIXTURE));
  });

  afterAll(async () => {
    await client.end();
  });

  const count = async (table: typeof topics | typeof topicPrerequisites | typeof diagnosticItems): Promise<number> => {
    const [row] = await db.select({ n: sql<number>`count(*)::int` }).from(table);
    return row?.n ?? 0;
  };

  it('loads the 5-topic fixture with parents, prerequisite edges and items', async () => {
    await expect(loadSeed(db, data)).resolves.toEqual({ topics: 5, prerequisites: 3, items: 3 });

    const hooks = await db.query.topics.findFirst({ where: eq(topics.slug, 'react-hooks') });
    const js = await db.query.topics.findFirst({ where: eq(topics.slug, 'javascript') });
    expect(hooks).toMatchObject({ canonicalName: 'React hooks', domain: 'software', origin: 'seed', parentId: js?.id });
    expect(hooks?.aliases).toEqual(['hooks', 'useState', 'useEffect']);
    expect(hooks?.embedding).toBeNull();

    const item = await db.query.diagnosticItems.findFirst({ where: eq(diagnosticItems.seedKey, 'javascript:nov-c1-typeof') });
    expect(item).toMatchObject({ stage: 'novice', bloom: 'C1', kind: 'single_choice', reviewed: true });
    expect(item?.body).toMatchObject({ answerKey: { optionIds: ['b'] } });
  });

  it('is idempotent: a second load changes no row counts', async () => {
    const before = [await count(topics), await count(topicPrerequisites), await count(diagnosticItems)];

    await loadSeed(db, data);

    expect([await count(topics), await count(topicPrerequisites), await count(diagnosticItems)]).toEqual(before);
    expect(before[0]).toBeGreaterThanOrEqual(5);
  });

  it('converges on edited files: renamed topic, dropped edge and edited item', async () => {
    const edited: SeedData = {
      topics: data.topics.map((t) =>
        t.slug === 'machine-learning-basics'
          ? { ...t, canonicalName: 'ML fundamentals', prerequisites: ['linear-algebra'] }
          : t,
      ),
      items: data.items.map((i) => (i.key === 'nov-c1-typeof' ? { ...i, bloom: 'C2' as const } : i)),
    };

    await loadSeed(db, edited);

    const ml = await db.query.topics.findFirst({ where: eq(topics.slug, 'machine-learning-basics') });
    const edges = await db.select().from(topicPrerequisites).where(eq(topicPrerequisites.topicId, ml?.id ?? ''));
    const item = await db.query.diagnosticItems.findFirst({ where: eq(diagnosticItems.seedKey, 'javascript:nov-c1-typeof') });
    expect(ml?.canonicalName).toBe('ML fundamentals');
    expect(edges).toHaveLength(1);
    expect(item?.bloom).toBe('C2');
  });
});
