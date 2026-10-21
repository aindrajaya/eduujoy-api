import { randomUUID } from 'node:crypto';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { eq } from 'drizzle-orm';
import { type Client } from 'pg';
import { jobs } from '../../src/shared/db/schema/jobs';
import { EventBus } from '../../src/shared/events/event-bus';
import { UnitOfWork } from '../../src/shared/events/unit-of-work';
import { JobQueue, JobSignals } from '../../src/shared/jobs/job-queue';
import { JobRepository } from '../../src/shared/jobs/job.repository';
import { connectTestClient, testDb, type TestDb } from '../db/connect';

describe('JobRepository and JobQueue (integration)', () => {
  let client: Client;
  let db: TestDb;
  let repo: JobRepository;

  beforeAll(async () => {
    client = await connectTestClient();
    db = testDb(client);
    repo = new JobRepository(db);
  });

  afterAll(async () => {
    await client.end();
  });

  // Each test uses its own job type so tests never claim each other's rows.
  const type = (): string => `t-${randomUUID().slice(0, 8)}`;
  const past = new Date(Date.now() - 1000);

  it('enqueues idempotently: the same key returns the existing job', async () => {
    const t = type();
    const key = `key-${randomUUID()}`;

    const first = await repo.enqueue({ type: t, idempotencyKey: key, payload: { a: 1 } });
    const second = await repo.enqueue({ type: t, idempotencyKey: key, payload: { a: 2 } });

    expect(first.created).toBe(true);
    expect(second).toMatchObject({ created: false, job: { id: first.job.id, payload: { a: 1 }, status: 'queued' } });
  });

  it('commits the job with the state change and wakes the executor only after commit', async () => {
    const signals = new JobSignals();
    let wakes = 0;
    signals.onWake(() => (wakes += 1));
    const queue = new JobQueue(repo, signals);
    const uow = new UnitOfWork(db, new EventBus(new EventEmitter2()));
    const committedKey = `commit-${randomUUID()}`;
    const rolledBackKey = `rollback-${randomUUID()}`;

    await uow.run((tx, scope) => queue.enqueue({ type: type(), idempotencyKey: committedKey, payload: {} }, { tx, scope }));
    await expect(
      uow.run(async (tx, scope) => {
        await queue.enqueue({ type: type(), idempotencyKey: rolledBackKey, payload: {} }, { tx, scope });
        throw new Error('abort');
      }),
    ).rejects.toThrow('abort');

    expect(await db.select().from(jobs).where(eq(jobs.idempotencyKey, committedKey))).toHaveLength(1);
    expect(await db.select().from(jobs).where(eq(jobs.idempotencyKey, rolledBackKey))).toHaveLength(0);
    expect(wakes).toBe(1);
  });

  it('claims only due jobs of the requested types and increments attempts', async () => {
    const t = type();
    await repo.enqueue({ type: t, idempotencyKey: randomUUID(), payload: { n: 'later' }, runAfter: new Date(Date.now() + 60_000) });
    const due = await repo.enqueue({ type: t, idempotencyKey: randomUUID(), payload: { n: 'now' }, runAfter: past });

    await expect(repo.claimNext([type()], new Date())).resolves.toBeUndefined();
    const claimed = await repo.claimNext([t], new Date());

    expect(claimed).toMatchObject({ id: due.job.id, status: 'running', attempts: 1 });
    await expect(repo.claimNext([t], new Date())).resolves.toBeUndefined();
  });

  it('never hands the same job to two concurrent claimers (SKIP LOCKED)', async () => {
    const t = type();
    for (let i = 0; i < 2; i += 1) await repo.enqueue({ type: t, idempotencyKey: randomUUID(), payload: {}, runAfter: past });
    const [c1, c2] = await Promise.all([connectTestClient(), connectTestClient()]);
    try {
      const [a, b] = await Promise.all([
        new JobRepository(testDb(c1)).claimNext([t], new Date()),
        new JobRepository(testDb(c2)).claimNext([t], new Date()),
      ]);
      expect(a?.id).toBeDefined();
      expect(b?.id).toBeDefined();
      expect(a?.id).not.toBe(b?.id);
    } finally {
      await Promise.all([c1.end(), c2.end()]);
    }
  });

  it('moves a failed attempt to failed (retry at run_after) and the last one to dead', async () => {
    const t = type();
    const { job } = await repo.enqueue({ type: t, idempotencyKey: randomUUID(), payload: {}, runAfter: past });
    await repo.claimNext([t], new Date());

    await repo.fail(job.id, 'boom', new Date(Date.now() - 1));
    expect(await repo.findById(job.id)).toMatchObject({ status: 'failed', error: 'boom' });
    expect(await repo.claimNext([t], new Date())).toMatchObject({ id: job.id, attempts: 2 });

    await repo.fail(job.id, 'boom again', null);
    expect(await repo.findById(job.id)).toMatchObject({ status: 'dead', error: 'boom again', lockedAt: null });
  });

  it('requeues jobs left running by a crash, keeping their attempt count', async () => {
    const t = type();
    const { job } = await repo.enqueue({ type: t, idempotencyKey: randomUUID(), payload: {}, runAfter: past });
    await repo.claimNext([t], new Date());

    const requeued = await repo.requeueRunning();

    expect(requeued).toContain(job.id);
    expect(await repo.findById(job.id)).toMatchObject({ status: 'queued', attempts: 1, lockedAt: null });
  });

  it('appends events with increasing ids and replays those after a given id', async () => {
    const { job } = await repo.enqueue({ type: type(), idempotencyKey: randomUUID(), payload: {} });
    const first = await repo.appendEvent(job.id, 'progress', { stage: 'discover', done: 1, total: 3 });
    const second = await repo.appendEvent(job.id, 'progress', { stage: 'discover', done: 2, total: 3 });
    const third = await repo.appendEvent(job.id, 'completed', { resultRef: '/v1/paths/x' });

    expect(second.id).toBeGreaterThan(first.id);
    expect((await repo.eventsAfter(job.id, first.id)).map((e) => e.id)).toEqual([second.id, third.id]);
    expect(await repo.eventsAfter(job.id)).toHaveLength(3);
  });
});
