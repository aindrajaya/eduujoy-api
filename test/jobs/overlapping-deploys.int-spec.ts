import { randomUUID } from 'node:crypto';
import { Logger } from '@nestjs/common';
import { eq } from 'drizzle-orm';
import { type Client } from 'pg';
import { jobs } from '../../src/shared/db/schema/jobs';
import { JobExecutor } from '../../src/shared/jobs/job-executor';
import { type JobHandler } from '../../src/shared/jobs/job-handler';
import { JobSignals } from '../../src/shared/jobs/job-queue';
import { JobRepository } from '../../src/shared/jobs/job.repository';
import { connectTestClient, testDb, type TestDb } from '../db/connect';

jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Two executors on one database, like an old and a new instance during a deploy (lead review). */
describe('overlapping deploys (integration)', () => {
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

  function blocking(type: string): { handler: JobHandler; release: () => void; started: Promise<void> } {
    let release: () => void = () => undefined;
    let markStarted: () => void = () => undefined;
    const gate = new Promise<void>((r) => (release = r));
    const started = new Promise<void>((r) => (markStarted = r));
    return {
      release: () => {
        release();
      },
      started,
      handler: {
        type,
        concurrency: 1,
        timeoutMs: 200,
        parse: (p) => p,
        run: async () => {
          markStarted();
          await gate;
          return { resultRef: '/from-old-instance' };
        },
      },
    };
  }

  const finishing = (type: string): JobHandler => ({
    type,
    concurrency: 1,
    timeoutMs: 200,
    parse: (p) => p,
    run: () => Promise.resolve({ resultRef: '/from-new-instance' }),
  });

  async function waitFor(id: string, status: string, ms = 10_000) {
    const until = Date.now() + ms;
    for (;;) {
      const job = await repo.findById(id);
      if (job?.status === status) return job;
      if (Date.now() > until) throw new Error(`job ${id} stuck in ${job?.status ?? 'missing'}`);
      await sleep(25);
    }
  }

  it("a booting instance leaves another instance's fresh lock alone; the old one finishes its job", async () => {
    const type = `deploy-${randomUUID().slice(0, 8)}`;
    const oldOne = blocking(type);
    // timeoutMs 200 in the handler, but this test releases the gate before then.
    oldOne.handler.timeoutMs = 5_000;
    const a = new JobExecutor(repo, new JobSignals(), { problemBaseUrl: 'http://x', staleGraceMs: 60_000 });
    a.register(oldOne.handler);
    const { job } = await repo.enqueue({ type, idempotencyKey: randomUUID(), payload: {} });
    await a.start();
    await oldOne.started;

    const b = new JobExecutor(repo, new JobSignals(), { problemBaseUrl: 'http://x', staleGraceMs: 60_000 });
    b.register(finishing(type));
    await b.start();

    expect(await repo.findById(job.id)).toMatchObject({ status: 'running', attempts: 1 });
    oldOne.release();
    expect(await waitFor(job.id, 'succeeded')).toMatchObject({ attempts: 1, result: { resultRef: '/from-old-instance' } });
    await Promise.all([a.stop(), b.stop()]);
  });

  it('a stopping instance releases its unfinished job and the new instance completes it', async () => {
    const type = `deploy-${randomUUID().slice(0, 8)}`;
    const oldOne = blocking(type);
    oldOne.handler.timeoutMs = 5_000;
    const a = new JobExecutor(repo, new JobSignals(), { problemBaseUrl: 'http://x', stopTimeoutMs: 100, staleGraceMs: 300 });
    a.register(oldOne.handler);
    const { job } = await repo.enqueue({ type, idempotencyKey: randomUUID(), payload: {} });
    await a.start();
    await oldOne.started;

    const b = new JobExecutor(repo, new JobSignals(), { problemBaseUrl: 'http://x', staleGraceMs: 300 });
    b.register(finishing(type));
    await b.start();
    await a.stop();

    expect(['queued', 'running', 'succeeded']).toContain((await repo.findById(job.id))?.status);
    const done = await waitFor(job.id, 'succeeded');
    expect(done).toMatchObject({ attempts: 2, result: { resultRef: '/from-new-instance' } });

    // The old run settling late must not overwrite the new instance's result.
    oldOne.release();
    await a.idle();
    expect(await repo.findById(job.id)).toMatchObject({ status: 'succeeded', result: { resultRef: '/from-new-instance' } });
    await b.stop();
  });

  it('requeues a lock older than the longest timeout plus the grace on boot', async () => {
    const type = `deploy-${randomUUID().slice(0, 8)}`;
    const { job } = await repo.enqueue({ type, idempotencyKey: randomUUID(), payload: {}, runAfter: new Date(Date.now() - 1000) });
    await repo.claimNext([type]);
    await db.update(jobs).set({ lockedAt: new Date(Date.now() - 120_000) }).where(eq(jobs.id, job.id));

    const b = new JobExecutor(repo, new JobSignals(), { problemBaseUrl: 'http://x', staleGraceMs: 60_000 });
    b.register(finishing(type));
    await b.start();

    expect(await waitFor(job.id, 'succeeded')).toMatchObject({ attempts: 2 });
    await b.stop();
  });

  it('arms a timer for a fresh lock and requeues it once it goes stale (crashed old instance)', async () => {
    const type = `deploy-${randomUUID().slice(0, 8)}`;
    const { job } = await repo.enqueue({ type, idempotencyKey: randomUUID(), payload: {}, runAfter: new Date(Date.now() - 1000) });
    // A crashed instance claimed it a moment ago and will never finish.
    await repo.claimNext([type]);

    const b = new JobExecutor(repo, new JobSignals(), { problemBaseUrl: 'http://x', staleGraceMs: 500 });
    b.register(finishing(type));
    await b.start();

    expect(await repo.findById(job.id)).toMatchObject({ status: 'running' });
    // timeoutMs 200 + grace 500 = stale after 700 ms (the timer waits at least 1 s).
    expect(await waitFor(job.id, 'succeeded', 5_000)).toMatchObject({ attempts: 2 });
    await b.stop();
  });
});
