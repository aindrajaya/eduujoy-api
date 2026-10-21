import { EventEmitter2 } from '@nestjs/event-emitter';
import { eq } from 'drizzle-orm';
import { type Client } from 'pg';
import { topics } from '../../src/shared/db/schema/catalog';
import { EventBus } from '../../src/shared/events/event-bus';
import { UnitOfWork } from '../../src/shared/events/unit-of-work';
import { connectTestClient, testDb, type TestDb } from '../db/connect';

describe('UnitOfWork (integration)', () => {
  let client: Client;
  let db: TestDb;
  let seen: string[];
  let uow: UnitOfWork;

  beforeAll(async () => {
    client = await connectTestClient();
    db = testDb(client);
  });

  beforeEach(() => {
    seen = [];
    const bus = new EventBus(new EventEmitter2());
    bus.on('TopicSaved', (e: { type: 'TopicSaved'; occurredAt: Date; slug: string }) => seen.push(e.slug));
    uow = new UnitOfWork(db, bus);
  });

  afterAll(async () => {
    await client.end();
  });

  const event = (slug: string) => ({ type: 'TopicSaved', occurredAt: new Date(), slug });

  it('commits the write and then publishes', async () => {
    await uow.run(async (tx, scope) => {
      await tx.insert(topics).values({ slug: 'uow-commit', canonicalName: 'Commit' });
      scope.publish(event('uow-commit'));
    });

    expect(await db.select().from(topics).where(eq(topics.slug, 'uow-commit'))).toHaveLength(1);
    expect(seen).toEqual(['uow-commit']);
  });

  it('rolls back the write and publishes nothing', async () => {
    await expect(
      uow.run(async (tx, scope) => {
        await tx.insert(topics).values({ slug: 'uow-rollback', canonicalName: 'Rollback' });
        scope.publish(event('uow-rollback'));
        throw new Error('abort');
      }),
    ).rejects.toThrow('abort');

    expect(await db.select().from(topics).where(eq(topics.slug, 'uow-rollback'))).toHaveLength(0);
    expect(seen).toEqual([]);
  });
});
