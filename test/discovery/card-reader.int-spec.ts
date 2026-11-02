import { randomUUID } from 'node:crypto';
import { type Client } from 'pg';
import { ServedCardsQuery } from '../../src/modules/discovery/application/served-cards.query';
import { DrizzleCardReader } from '../../src/modules/discovery/infrastructure/drizzle-card.reader';
import { topics } from '../../src/shared/db/schema/catalog';
import { discoveryResults, resourceCards, resources } from '../../src/shared/db/schema/discovery';
import { connectTestClient, testDb, type TestDb } from '../db/connect';

const QUALITY = { relevance: 80, accuracySignals: 80, recency: 80, teaching: 80 };

describe('ServedCardsQuery (integration, A9)', () => {
  let client: Client;
  let db: TestDb;
  let query: ServedCardsQuery;

  beforeAll(async () => {
    client = await connectTestClient();
    db = testDb(client);
    query = new ServedCardsQuery(new DrizzleCardReader(db));
  });

  afterAll(async () => {
    await client.end();
  });

  async function topic(): Promise<string> {
    const tag = randomUUID().slice(0, 8);
    const [row] = await db.insert(topics).values({ slug: `cards-${tag}`, canonicalName: `Cards ${tag}`, domain: 'software' }).returning({ id: topics.id });
    return row?.id ?? '';
  }

  async function resource(topicId: string, over: { title: string; deadAt?: Date; cards: { takeaway: string; at: Date; version?: string }[] }): Promise<string> {
    const [row] = await db
      .insert(resources)
      .values({ url: `https://example.com/${randomUUID()}`, type: 'article', title: over.title, source: 'example.com', readingMin: 7, deadAt: over.deadAt ?? null })
      .returning({ id: resources.id });
    const id = row?.id ?? '';
    for (const card of over.cards) {
      await db.insert(resourceCards).values({
        resourceId: id,
        topicId,
        model: 'm',
        promptVersion: card.version ?? 'v1',
        dreyfusStage: 'competent',
        bloomLevels: ['C3', 'C4'],
        prerequisites: ['basics'],
        concepts: [{ name: 'Effects', start: null, end: null }],
        keyTakeaways: [card.takeaway],
        quality: QUALITY,
        qualityScore: 80,
        confidence: 0.9,
        evidence: 'x',
        status: 'served',
        expiresAt: new Date(Date.now() + 86_400_000),
        createdAt: card.at,
      });
    }
    return id;
  }

  it("returns the latest pool's live served cards in pool order, newest card per resource", async () => {
    const topicId = await topic();
    const a = await resource(topicId, { title: 'A', cards: [{ takeaway: 'old', at: new Date(Date.now() - 60_000) }, { takeaway: 'new', at: new Date(), version: 'v2' }] });
    const b = await resource(topicId, { title: 'B', cards: [{ takeaway: 'b', at: new Date() }] });
    const dead = await resource(topicId, { title: 'Dead', deadAt: new Date(), cards: [{ takeaway: 'd', at: new Date() }] });
    const expires = new Date(Date.now() + 86_400_000);
    await db.insert(discoveryResults).values([
      { topicId, stage: 'competent', poolVersion: 1, status: 'ready', resourceIds: [a], expiresAt: expires },
      { topicId, stage: 'competent', poolVersion: 2, status: 'ready', candidateIds: [a, b, dead], analysedIds: [a, b, dead], resourceIds: [b, dead, a], expiresAt: expires },
    ]);

    const { pool, cards } = await query.pool(topicId, 'competent');
    expect(pool).toMatchObject({ poolVersion: 2, status: 'ready', candidates: 3, analysed: 3 });
    expect(cards.map((c) => [c.title, c.keyTakeaways])).toEqual([
      ['B', ['b']],
      ['A', ['new']],
    ]);
    expect(cards[1]).toMatchObject({ resourceId: a, type: 'article', readingMin: 7, stage: 'competent', bloomLevels: ['C3', 'C4'], quality: QUALITY });
    // A saved path still shows what it cited, dead resources included.
    expect((await query.cited(topicId, [dead, a])).map((c) => c.title)).toEqual(['Dead', 'A']);
    // Another topic's card for the same resource is not this topic's card.
    expect(await query.cited(await topic(), [a])).toEqual([]);
  });

  it('returns no cards while the pool analyses, and no pool when there is none', async () => {
    const topicId = await topic();
    expect(await query.pool(topicId, 'novice')).toEqual({ pool: null, cards: [] });
    await db.insert(discoveryResults).values({ topicId, stage: 'novice', poolVersion: 1, status: 'analysing', candidateIds: [randomUUID()], expiresAt: new Date(Date.now() + 86_400_000) });
    expect(await query.pool(topicId, 'novice')).toMatchObject({ pool: { status: 'analysing', candidates: 1, analysed: 0 }, cards: [] });
  });
});
