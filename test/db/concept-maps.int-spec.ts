import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { type Client } from 'pg';
import { DrizzleConceptMapReader } from '../../src/modules/catalog/infrastructure/drizzle-concept-map.reader';
import { type ConceptMap } from '../../src/shared/common/concept-map';
import { loadConceptMaps, readConceptMaps } from '../../src/shared/db/seed/concept-maps';
import { topicConceptMaps, topics } from '../../src/shared/db/schema/catalog';
import { connectTestClient, testDb, type TestDb } from './connect';

const stage = (name: ConceptMap['stages'][number]['stage'], p: string): ConceptMap['stages'][number] => ({
  stage: name,
  bloomBand: ['C1'],
  concepts: [{ id: `${p}-1`, name: `${p} one`, aliases: [], bloom: 'C1', summary: 'A concept.' }],
  prerequisites: [],
  misconceptions: [],
});
const mapFor = (slug: string, name = 'nov'): ConceptMap => ({
  version: 1,
  topic: slug,
  language: 'en',
  promptVersion: 'v1',
  stages: [stage('novice', name), stage('advanced_beginner', 'adb'), stage('competent', 'com'), stage('proficient', 'pro'), stage('expert', 'exp')],
});

describe('concept maps in the database (user, 3 Nov 2026)', () => {
  let client: Client;
  let db: TestDb;

  beforeAll(async () => {
    client = await connectTestClient();
    db = testDb(client);
  });

  afterAll(async () => {
    await client.end();
  });

  async function seedTopic(origin: 'seed' | 'learner' = 'seed'): Promise<{ id: string; slug: string }> {
    const slug = `map-${randomUUID().slice(0, 8)}`;
    const [row] = await db.insert(topics).values({ slug, canonicalName: slug, origin }).returning({ id: topics.id, slug: topics.slug });
    if (!row) throw new Error('no topic');
    return row;
  }

  it('upserts maps onto seed topics, counts only real changes, and serves them validated', async () => {
    const t = await seedTopic();
    await expect(loadConceptMaps(db, [{ slug: t.slug, map: mapFor(t.slug) }])).resolves.toEqual({ loaded: 1, changed: 1 });
    await expect(loadConceptMaps(db, [{ slug: t.slug, map: mapFor(t.slug) }])).resolves.toEqual({ loaded: 1, changed: 0 });
    await expect(loadConceptMaps(db, [{ slug: t.slug, map: mapFor(t.slug, 'nvc') }])).resolves.toEqual({ loaded: 1, changed: 1 });

    const reader = new DrizzleConceptMapReader(db);
    expect((await reader.forTopic(t.id))?.stages[0]?.concepts[0]?.id).toBe('nvc-1');
    expect(await reader.forTopic(randomUUID())).toBeNull();
  });

  it('refuses a map for a topic that is not a seed topic, writing nothing; a map that left the files keeps its row', async () => {
    const seed = await seedTopic();
    const learner = await seedTopic('learner');
    await expect(loadConceptMaps(db, [{ slug: seed.slug, map: mapFor(seed.slug) }, { slug: learner.slug, map: mapFor(learner.slug) }])).rejects.toThrow(/not seed topics/);
    expect(await db.select().from(topicConceptMaps).where(eq(topicConceptMaps.topicId, seed.id))).toEqual([]);

    await loadConceptMaps(db, [{ slug: seed.slug, map: mapFor(seed.slug) }]);
    await loadConceptMaps(db, []);
    expect(await db.select({ id: topicConceptMaps.topicId }).from(topicConceptMaps).where(eq(topicConceptMaps.topicId, seed.id))).toHaveLength(1);
  });

  it('a stored map that no longer parses is served as none', async () => {
    const t = await seedTopic();
    await db.insert(topicConceptMaps).values({ topicId: t.id, version: 1, promptVersion: 'v1', map: { version: 1, broken: true } });
    expect(await new DrizzleConceptMapReader(db).forTopic(t.id)).toBeNull();
  });

  it('reads and validates the real seed/concept-maps (160 topics)', () => {
    const maps = readConceptMaps('seed');
    expect(maps).toHaveLength(160);
    expect(maps.every((m) => m.map.topic === m.slug)).toBe(true);
  });
});
