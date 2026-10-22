import { randomUUID } from 'node:crypto';
import { type Client } from 'pg';
import { users } from '../../src/shared/db/schema/identity';
import { JobRepository } from '../../src/shared/jobs';
import { connectTestClient, testDb, type TestDb } from '../db/connect';

describe('JobRepository.countForUser (integration)', () => {
  let client: Client;
  let db: TestDb;

  beforeAll(async () => {
    client = await connectTestClient();
    db = testDb(client);
  });

  afterAll(async () => {
    await client.end();
  });

  it('counts one type of job a user triggered since a time, per user', async () => {
    const [a, b] = await db
      .insert(users)
      .values([{ email: `count-a-${randomUUID()}@example.com` }, { email: `count-b-${randomUUID()}@example.com` }])
      .returning({ id: users.id });
    if (!a || !b) throw new Error('users not created');
    const repo = new JobRepository(db);
    const since = new Date(Date.now() - 60_000);
    for (const [userId, type] of [[a.id, 'int-discover'], [a.id, 'int-discover'], [a.id, 'int-other'], [b.id, 'int-discover']] as const) {
      await repo.enqueue({ type, idempotencyKey: `${type}:${randomUUID()}`, payload: {}, userId });
    }

    await expect(repo.countForUser('int-discover', a.id, since)).resolves.toBe(2);
    await expect(repo.countForUser('int-discover', b.id, since)).resolves.toBe(1);
    await expect(repo.countForUser('int-discover', a.id, new Date(Date.now() + 60_000))).resolves.toBe(0);
  });
});
