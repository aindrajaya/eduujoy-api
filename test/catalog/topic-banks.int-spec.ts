import { randomUUID } from 'node:crypto';
import { type Client } from 'pg';
import { DrizzleTopicBanks } from '../../src/shared/common/topic-banks';
import { diagnosticItems } from '../../src/shared/db/schema/assessment';
import { topics } from '../../src/shared/db/schema/catalog';
import { connectTestClient, testDb, type TestDb } from '../db/connect';

describe('DrizzleTopicBanks (integration)', () => {
  let client: Client;
  let db: TestDb;

  beforeAll(async () => {
    client = await connectTestClient();
    db = testDb(client);
  });

  afterAll(async () => {
    await client.end();
  });

  it('reports topics with a servable item in one query; short answers alone do not count', async () => {
    const tag = randomUUID().slice(0, 8);
    const [banked, shortOnly, empty] = await db
      .insert(topics)
      .values(['banked', 'short', 'empty'].map((s) => ({ slug: `banks-${s}-${tag}`, canonicalName: `Banks ${s} ${tag}` })))
      .returning({ id: topics.id });
    if (!banked || !shortOnly || !empty) throw new Error('topics not created');
    const item = (topicId: string, kind: 'single_choice' | 'short_answer') => ({
      topicId,
      stage: 'novice' as const,
      bloom: 'C1' as const,
      kind,
      body: { prompt: 'p', options: [], answerKey: { optionIds: [] } },
    });
    await db.insert(diagnosticItems).values([item(banked.id, 'single_choice'), item(banked.id, 'single_choice'), item(shortOnly.id, 'short_answer')]);

    const result = await new DrizzleTopicBanks(db).withBank([banked.id, shortOnly.id, empty.id, banked.id]);

    expect([...result]).toEqual([banked.id]);
    await expect(new DrizzleTopicBanks(db).withBank([])).resolves.toEqual(new Set());
  });
});
