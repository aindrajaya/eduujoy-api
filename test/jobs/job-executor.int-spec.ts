import { randomUUID } from 'node:crypto';
import { Logger } from '@nestjs/common';
import { type Client } from 'pg';
import { AiBudgetExceededError } from '../../src/shared/ai/errors';
import { JobExecutor } from '../../src/shared/jobs/job-executor';
import { type JobHandler, NonRetryableJobError } from '../../src/shared/jobs/job-handler';
import { JobQueue, JobSignals } from '../../src/shared/jobs/job-queue';
import { JobRepository } from '../../src/shared/jobs/job.repository';
import { type JobEvent } from '../../src/shared/jobs/job.types';
import { connectTestClient, testDb } from '../db/connect';

jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe('JobExecutor (integration)', () => {
  let client: Client;
  let repo: JobRepository;
  let signals: JobSignals;
  let queue: JobQueue;
  let executor: JobExecutor;
  let events: JobEvent[];

  beforeEach(async () => {
    client = await connectTestClient();
    repo = new JobRepository(testDb(client));
    signals = new JobSignals();
    queue = new JobQueue(repo, signals);
    executor = new JobExecutor(repo, signals, { problemBaseUrl: 'http://localhost:3000', retryBaseMs: 20, random: () => 0.5 });
    events = [];
    executor.onEvent((e) => events.push(e));
  });

  afterEach(async () => {
    await executor.stop();
    await client.end();
  });

  const handler = (over: Partial<JobHandler<{ n: number }>> & Pick<JobHandler<{ n: number }>, 'run'>): JobHandler<{ n: number }> => ({
    type: `x-${randomUUID().slice(0, 8)}`,
    concurrency: 2,
    timeoutMs: 5_000,
    parse: (p) => p as { n: number },
    ...over,
  });

  async function waitFor(id: string, statuses: string[], ms = 10_000) {
    const until = Date.now() + ms;
    for (;;) {
      const job = await repo.findById(id);
      if (job && statuses.includes(job.status)) return job;
      if (Date.now() > until) throw new Error(`job ${id} stuck in ${job?.status ?? 'missing'}`);
      await sleep(25);
    }
  }

  it('runs an enqueued job, persists progress and the result, and emits events in order', async () => {
    const h = handler({
      run: async (p, ctx) => {
        await ctx.progress('discover', 1, 2, 'Searching');
        await ctx.progress('design', 2, 2);
        return { resultRef: `/v1/paths/p-${p.n}` };
      },
    });
    executor.register(h);
    await executor.start();

    const { job } = await queue.enqueue({ type: h.type, idempotencyKey: randomUUID(), payload: { n: 7 } });
    const done = await waitFor(job.id, ['succeeded']);
    await executor.idle();

    expect(done).toMatchObject({ attempts: 1, result: { resultRef: '/v1/paths/p-7' }, progress: { stage: 'design', done: 2, total: 2 } });
    expect(events.map((e) => [e.type, (e.data as { stage?: string }).stage ?? null])).toEqual([
      ['progress', 'discover'],
      ['progress', 'design'],
      ['completed', null],
    ]);
    expect(events.at(-1)?.data).toEqual({ jobId: job.id, resultRef: '/v1/paths/p-7' });
    expect((await repo.eventsAfter(job.id)).map((e) => e.id)).toEqual(events.map((e) => e.id));
  });

  it('never runs more than `concurrency` jobs of a type at once', async () => {
    let active = 0;
    let peak = 0;
    const h = handler({
      concurrency: 2,
      run: async () => {
        active += 1;
        peak = Math.max(peak, active);
        await sleep(80);
        active -= 1;
        return { resultRef: '/x' };
      },
    });
    executor.register(h);
    await executor.start();

    const ids = await Promise.all(
      [1, 2, 3, 4, 5].map(async (n) => (await queue.enqueue({ type: h.type, idempotencyKey: randomUUID(), payload: { n } })).job.id),
    );
    for (const id of ids) await waitFor(id, ['succeeded']);

    expect(peak).toBe(2);
  });

  it('retries a failed attempt after backoff and then succeeds', async () => {
    const h = handler({
      run: (_p, ctx) => (ctx.attempt === 1 ? Promise.reject(new Error('transient')) : Promise.resolve({ resultRef: '/ok' })),
    });
    executor.register(h);
    await executor.start();

    const { job } = await queue.enqueue({ type: h.type, idempotencyKey: randomUUID(), payload: { n: 1 }, maxAttempts: 3 });
    const done = await waitFor(job.id, ['succeeded']);

    expect(done.attempts).toBe(2);
    expect(events.some((e) => e.type === 'progress' && (e.data as { message?: string }).message === 'Retrying (attempt 2 of 3)')).toBe(true);
  });

  it('goes dead after the last attempt with an opaque INTERNAL problem', async () => {
    const h = handler({ run: () => Promise.reject(new Error('db password is hunter2')) });
    executor.register(h);
    await executor.start();

    const { job } = await queue.enqueue({ type: h.type, idempotencyKey: randomUUID(), payload: { n: 1 }, maxAttempts: 2 });
    const dead = await waitFor(job.id, ['dead']);
    await executor.idle();

    expect(dead).toMatchObject({ attempts: 2, error: 'db password is hunter2' });
    const failed = events.find((e) => e.type === 'failed');
    expect(failed?.data).toMatchObject({ jobId: job.id, retryable: false, problem: { code: 'INTERNAL', status: 500, requestId: `job:${job.id}` } });
    expect(JSON.stringify(failed?.data)).not.toContain('hunter2');
  });

  it('does not retry a NonRetryableJobError or a payload that fails to parse', async () => {
    const h = handler({ run: () => Promise.reject(new NonRetryableJobError('bad input')) });
    const bad = handler({
      parse: () => {
        throw new NonRetryableJobError('payload invalid');
      },
      run: () => Promise.resolve({ resultRef: '/never' }),
    });
    executor.register(h);
    executor.register(bad);
    await executor.start();

    const a = await queue.enqueue({ type: h.type, idempotencyKey: randomUUID(), payload: { n: 1 }, maxAttempts: 3 });
    const b = await queue.enqueue({ type: bad.type, idempotencyKey: randomUUID(), payload: { n: 1 }, maxAttempts: 3 });

    expect(await waitFor(a.job.id, ['dead'])).toMatchObject({ attempts: 1 });
    expect(await waitFor(b.job.id, ['dead'])).toMatchObject({ attempts: 1 });
  });

  it('times a job out, aborts its signal and counts it as a failed attempt', async () => {
    let aborted = false;
    const h = handler({
      timeoutMs: 50,
      run: (_p, ctx) =>
        new Promise((resolve) => {
          ctx.signal.addEventListener('abort', () => {
            aborted = true;
          });
          setTimeout(() => {
            resolve({ resultRef: '/late' });
          }, 1_000);
        }),
    });
    executor.register(h);
    await executor.start();

    const { job } = await queue.enqueue({ type: h.type, idempotencyKey: randomUUID(), payload: { n: 1 }, maxAttempts: 1 });
    const dead = await waitFor(job.id, ['dead']);

    expect(aborted).toBe(true);
    expect(dead.error).toContain('timed out');
  });

  it('wakes on a timer for a future run_after without any enqueue signal', async () => {
    const h = handler({ run: () => Promise.resolve({ resultRef: '/timer' }) });
    executor.register(h);
    // Insert directly (no JobQueue, so no wake signal) with a run_after shortly in the future.
    const { job } = await repo.enqueue({ type: h.type, idempotencyKey: randomUUID(), payload: { n: 1 }, runAfter: new Date(Date.now() + 300) });
    await executor.start();

    expect((await repo.findById(job.id))?.status).toBe('queued');
    await waitFor(job.id, ['succeeded'], 5_000);
  });

  it('reports a spent AI budget as AI_BUDGET_EXCEEDED', async () => {
    const h = handler({ run: () => Promise.reject(new AiBudgetExceededError(3.2, 3)) });
    executor.register(h);
    await executor.start();

    const { job } = await queue.enqueue({ type: h.type, idempotencyKey: randomUUID(), payload: { n: 1 }, maxAttempts: 1 });
    await waitFor(job.id, ['dead']);
    await executor.idle();

    expect(events.find((e) => e.type === 'failed')?.data).toMatchObject({ problem: { code: 'AI_BUDGET_EXCEEDED', status: 503 } });
  });
});

describe('JobExecutor timeouts (integration)', () => {
  let client: Client;
  let repo: JobRepository;

  beforeAll(async () => {
    client = await connectTestClient();
    repo = new JobRepository(testDb(client));
  });

  afterAll(async () => {
    await client.end();
  });

  async function waitForStatus(id: string, status: string, ms = 10_000) {
    const until = Date.now() + ms;
    for (;;) {
      const job = await repo.findById(id);
      if (job?.status === status) return job;
      if (Date.now() > until) throw new Error(`job ${id} stuck in ${job?.status ?? 'missing'}`);
      await sleep(25);
    }
  }

  it('waits for a run that ignores its abort signal to settle before the retry starts', async () => {
    const executor = new JobExecutor(repo, new JobSignals(), {
      problemBaseUrl: 'http://x',
      retryBaseMs: 0,
      abortGraceMs: 5_000,
    });
    let active = 0;
    let peak = 0;
    const type = `ignore-${randomUUID().slice(0, 8)}`;
    executor.register({
      type,
      concurrency: 2,
      timeoutMs: 50,
      parse: (p) => p,
      // Ignores ctx.signal on attempt 1 and finishes 400 ms later; attempt 2 is quick.
      run: async (_p, ctx) => {
        active += 1;
        peak = Math.max(peak, active);
        await sleep(ctx.attempt === 1 ? 400 : 0);
        active -= 1;
        return { resultRef: `/attempt-${ctx.attempt}` };
      },
    });
    const { job } = await repo.enqueue({ type, idempotencyKey: randomUUID(), payload: {}, maxAttempts: 2 });
    await executor.start();

    const done = await waitForStatus(job.id, 'succeeded');

    expect(peak).toBe(1);
    // The late result of the timed-out attempt is ignored; the retry's result is kept.
    expect(done).toMatchObject({ attempts: 2, result: { resultRef: '/attempt-2' } });
    await executor.stop();
  });

  it('schedules the retry after the grace period when the aborted run never settles', async () => {
    const executor = new JobExecutor(repo, new JobSignals(), { problemBaseUrl: 'http://x', retryBaseMs: 0, abortGraceMs: 150 });
    const type = `hang-${randomUUID().slice(0, 8)}`;
    executor.register({
      type,
      concurrency: 2,
      timeoutMs: 50,
      parse: (p) => p,
      run: (_p, ctx) => (ctx.attempt === 1 ? new Promise(() => undefined) : Promise.resolve({ resultRef: '/second' })),
    });
    const { job } = await repo.enqueue({ type, idempotencyKey: randomUUID(), payload: {}, maxAttempts: 2 });
    await executor.start();

    expect(await waitForStatus(job.id, 'succeeded')).toMatchObject({ attempts: 2, result: { resultRef: '/second' } });
    await executor.stop();
  });
});
