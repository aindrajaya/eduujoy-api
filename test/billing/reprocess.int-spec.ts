import { randomUUID } from 'node:crypto';
import { like } from 'drizzle-orm';
import { type Client } from 'pg';
import { ReprocessBillingEvent } from '../../src/modules/billing/application/reprocess-billing-event.usecase';
import { DrizzleBillingRepository } from '../../src/modules/billing/infrastructure/drizzle-billing.repository';
import { jobs } from '../../src/shared/db/schema/jobs';
import { JobQueue, JobRepository, JobSignals } from '../../src/shared/jobs';
import { connectTestClient, testDb, type TestDb } from '../db/connect';

describe('billing:reprocess (integration)', () => {
  let client: Client;
  let db: TestDb;

  beforeAll(async () => {
    client = await connectTestClient();
    db = testDb(client);
  });

  afterAll(async () => {
    await client.end();
  });

  it('queues a fresh billing-event job per run for an unprocessed event, and none once processed', async () => {
    const repo = new DrizzleBillingRepository(db);
    const eventId = await db.transaction((tx) => repo.recordEvent(tx, { providerEventId: randomUUID(), type: 'order_created', payload: { meta: {} } }));
    if (!eventId) throw new Error('event not recorded');
    let second = 0;
    const reprocess = new ReprocessBillingEvent(repo, new JobQueue(new JobRepository(db), new JobSignals()), () => new Date(Date.UTC(2026, 9, 22, 12, 0, ++second)));

    await expect(reprocess.execute(eventId, { dryRun: true })).resolves.toEqual({ outcome: 'would_queue', type: 'order_created' });
    await reprocess.execute(eventId, { dryRun: false });
    await reprocess.execute(eventId, { dryRun: false });

    const queued = await db.select().from(jobs).where(like(jobs.idempotencyKey, `billing:${eventId}:reprocess:%`));
    expect(queued).toHaveLength(2);
    expect(queued.map((j) => ({ type: j.type, status: j.status, payload: j.payload, maxAttempts: j.maxAttempts }))).toEqual([
      { type: 'billing-event', status: 'queued', payload: { eventId }, maxAttempts: 5 },
      { type: 'billing-event', status: 'queued', payload: { eventId }, maxAttempts: 5 },
    ]);

    await repo.markProcessed(eventId, 'credited:1');
    await expect(reprocess.execute(eventId, { dryRun: false })).resolves.toMatchObject({ outcome: 'already_processed' });
    expect(await db.select().from(jobs).where(like(jobs.idempotencyKey, `billing:${eventId}:reprocess:%`))).toHaveLength(2);
    // Leave no queued rows for other suites' executors.
    await db.delete(jobs).where(like(jobs.idempotencyKey, `billing:${eventId}:reprocess:%`));
  });
});
