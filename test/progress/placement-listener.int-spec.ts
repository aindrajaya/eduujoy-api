import { EventEmitter2 } from '@nestjs/event-emitter';
import { eq } from 'drizzle-orm';
import { type Client } from 'pg';
import { PlacementComputed } from '../../src/modules/assessment/domain/events/placement-computed.event';
import { GetTopicQuery } from '../../src/modules/catalog/application/get-topic.query';
import { DrizzleTopicRepository } from '../../src/modules/catalog/infrastructure/drizzle-topic.repository';
import { RecordPosition } from '../../src/modules/progress/application/record-position.usecase';
import { DrizzlePositionRepository } from '../../src/modules/progress/infrastructure/drizzle-position.repository';
import { PlacementComputedListener } from '../../src/modules/progress/infrastructure/placement-computed.listener';
import { topics } from '../../src/shared/db/schema/catalog';
import { users } from '../../src/shared/db/schema/identity';
import { learnerPositions } from '../../src/shared/db/schema/progress';
import { EventBus } from '../../src/shared/events/event-bus';
import { connectTestClient, testDb, type TestDb } from '../db/connect';

describe('catalog topic lookup and the progress placement listener (integration)', () => {
  let client: Client;
  let db: TestDb;
  let topicId: string;
  let userId: string;

  beforeAll(async () => {
    client = await connectTestClient();
    db = testDb(client);
    const [topic] = await db.insert(topics).values({ slug: 'a7-listener', canonicalName: 'Listener topic', aliases: ['lt'] }).returning();
    const [user] = await db.insert(users).values({ email: 'a7-listener@example.com' }).returning();
    topicId = topic?.id ?? '';
    userId = user?.id ?? '';
  });

  afterAll(async () => {
    await client.end();
  });

  it('GetTopicQuery returns the contract Topic, and null for unknown or malformed ids', async () => {
    const query = new GetTopicQuery(new DrizzleTopicRepository(db));

    await expect(query.execute(topicId)).resolves.toEqual({
      id: topicId,
      canonicalName: 'Listener topic',
      aliases: ['lt'],
      parentId: null,
      description: null,
    });
    await expect(query.execute('00000000-0000-4000-8000-000000000000')).resolves.toBeNull();
    await expect(query.execute('not-a-uuid')).resolves.toBeNull();
  });

  it('records a diagnostic position when PlacementComputed is published', async () => {
    const bus = new EventBus(new EventEmitter2());
    new PlacementComputedListener(bus, new RecordPosition(new DrizzlePositionRepository(db))).onModuleInit();

    await bus.publish(new PlacementComputed('11111111-1111-4111-8111-111111111111', userId, topicId, 'competent', 'C4', 0.87, 'items'));

    const rows = await db.select().from(learnerPositions).where(eq(learnerPositions.userId, userId));
    expect(rows).toEqual([
      expect.objectContaining({ topicId, stage: 'competent', bloom: 'C4', source: 'diagnostic' }),
    ]);
    expect(rows[0]?.confidence).toBeCloseTo(0.87, 5);
  });
});
