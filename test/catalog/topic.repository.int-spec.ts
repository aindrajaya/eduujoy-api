import { randomUUID } from 'node:crypto';
import { type Client } from 'pg';
import { DrizzleTopicRepository } from '../../src/modules/catalog/infrastructure/drizzle-topic.repository';
import { topics } from '../../src/shared/db/schema/catalog';
import { users } from '../../src/shared/db/schema/identity';
import { EMBEDDING_DIMENSIONS } from '../../src/shared/db/schema/common';
import { connectTestClient, testDb, type TestDb } from '../db/connect';

/** A 768-dim unit vector at `angle` in the first two dimensions: cosine to another is cos(Δangle). */
const at = (angle: number): number[] => {
  const v = new Array<number>(EMBEDDING_DIMENSIONS).fill(0);
  v[0] = Math.cos(angle);
  v[1] = Math.sin(angle);
  return v;
};
const MODEL = { model: 'gemini-embedding-2', version: 1 };

describe('DrizzleTopicRepository (integration)', () => {
  let client: Client;
  let db: TestDb;
  let repo: DrizzleTopicRepository;
  const tag = randomUUID().slice(0, 8);
  const slug = (s: string) => `${s}-${tag}`;

  beforeAll(async () => {
    client = await connectTestClient();
    db = testDb(client);
    repo = new DrizzleTopicRepository(db);
    await db.insert(topics).values([
      { slug: slug('hooks'), canonicalName: `React hooks ${tag}`, aliases: [`UseState-${tag}`], embedding: at(0), ...embeddingCols(MODEL) },
      { slug: slug('react'), canonicalName: `React ${tag}`, embedding: at(1.2), ...embeddingCols(MODEL) },
      { slug: slug('old'), canonicalName: `Old model ${tag}`, embedding: at(0.01), embeddingModel: 'other-model', embeddingVersion: 1 },
      { slug: slug('bare'), canonicalName: `No embedding ${tag}` },
    ]);
  });

  afterAll(async () => {
    await client.end();
  });

  it('finds exact names, aliases and slugs ignoring case', async () => {
    expect((await repo.findExact(`react hooks ${tag}`, 'x')).map((t) => t.canonicalName)).toEqual([`React hooks ${tag}`]);
    expect((await repo.findExact(`usestate-${tag}`, 'x')).map((t) => t.canonicalName)).toEqual([`React hooks ${tag}`]);
    expect((await repo.findExact('nothing', slug('react'))).map((t) => t.canonicalName)).toEqual([`React ${tag}`]);
    expect(await repo.findExact(`react hook ${tag}`, 'x')).toEqual([]);
  });

  it('returns nearest topics by cosine for the same model and version only', async () => {
    const near = await repo.nearest({ vector: at(Math.acos(0.9)), ...MODEL }, 50);
    const mine = near.filter((n) => n.topic.canonicalName.endsWith(tag));

    expect(mine.map((n) => n.topic.canonicalName)).toEqual([`React hooks ${tag}`, `React ${tag}`]);
    expect(mine[0]?.similarity).toBeCloseTo(0.9, 4);
    expect(mine[1]?.similarity).toBeCloseTo(Math.cos(1.2 - Math.acos(0.9)), 4);
  });

  it('creates a learner topic once per slug and counts creates per user and day', async () => {
    const [user] = await db.insert(users).values({ email: `topics-${randomUUID()}@example.com` }).returning();
    const userId = user?.id ?? '';
    const input = {
      slug: slug('pottery'),
      canonicalName: `Pottery ${tag}`,
      aliases: ['ceramics'],
      description: 'Shaping clay.',
      domain: 'non_technical' as const,
      createdBy: userId,
      needsReview: true,
      embedding: { vector: at(2), ...MODEL },
    };

    const limit = { since: new Date(Date.now() - 60_000), max: 10 };
    const first = await repo.create(input, limit);
    const again = await repo.create({ ...input, canonicalName: 'Different name' }, limit);

    expect(first).toMatchObject({ outcome: 'created', topic: { canonicalName: `Pottery ${tag}`, aliases: ['ceramics'], description: 'Shaping clay.' } });
    expect(again).toEqual({ outcome: 'exists', topic: first.outcome === 'limited' ? null : first.topic });
    expect(await repo.countCreatedBy(userId, new Date(Date.now() - 60_000))).toBe(1);
    expect(await repo.countCreatedBy(userId, new Date(Date.now() + 60_000))).toBe(0);
  });

  it('never lets parallel creates by one learner pass the cap', async () => {
    const [user] = await db.insert(users).values({ email: `cap-${randomUUID()}@example.com` }).returning();
    const createdBy = user?.id ?? '';
    const limit = { since: new Date(Date.now() - 60_000), max: 3 };
    const topic = (i: number) => ({ slug: slug(`cap-${i}`), canonicalName: `Cap ${i} ${tag}`, aliases: [], description: null, domain: null, createdBy, needsReview: false, embedding: null });

    // Separate connections, so the creates really race; the advisory lock serialises them.
    const clients = await Promise.all(Array.from({ length: 6 }, () => connectTestClient()));
    try {
      const results = await Promise.all(clients.map((c, i) => new DrizzleTopicRepository(testDb(c)).create(topic(i), limit)));
      expect(results.filter((r) => r.outcome === 'created')).toHaveLength(3);
      expect(results.filter((r) => r.outcome === 'limited')).toHaveLength(3);
    } finally {
      await Promise.all(clients.map((c) => c.end()));
    }
    expect(await repo.countCreatedBy(createdBy, limit.since)).toBe(3);
  });

  it('lists topics without a current embedding and stores new ones', async () => {
    const mine = (t: { canonicalName: string }) => t.canonicalName.endsWith(tag) && !t.canonicalName.startsWith('Cap ');
    const pending = (await repo.listUnembedded(MODEL.model, MODEL.version, 1000)).filter(mine);
    expect(pending.map((t) => t.canonicalName).sort()).toEqual([`No embedding ${tag}`, `Old model ${tag}`]);

    for (const t of pending) await repo.setEmbedding(t.id, { vector: at(3), ...MODEL });

    expect((await repo.listUnembedded(MODEL.model, MODEL.version, 1000)).filter(mine)).toEqual([]);
    expect((await repo.listUnembedded(MODEL.model, MODEL.version + 1, 1000)).some((t) => t.canonicalName === `React ${tag}`)).toBe(true);
  });
});

function embeddingCols(m: { model: string; version: number }) {
  return { embeddingModel: m.model, embeddingVersion: m.version };
}
