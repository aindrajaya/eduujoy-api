import { randomUUID } from 'node:crypto';
import { Logger } from '@nestjs/common';
import { type Client } from 'pg';
import { AiBudgetExceededError } from '../../src/shared/ai/errors';
import { JobExecutor } from '../../src/shared/jobs/job-executor';
import { type JobHandler, NonRetryableJobError, RescheduleJob } from '../../src/shared/jobs/job-handler';
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
    const waiters: (() => void)[] = [];
    // Each run waits (up to 2 s) until a second run is active, so reaching 2 doesn't depend on
    // Neon round trips being faster than the handler; a third concurrent run would still show up.
    const together = () =>
      new Promise<void>((resolve) => {
        if (active >= 2) {
          for (const w of waiters.splice(0)) w();
          resolve();
          return;
        }
        waiters.push(resolve);
        setTimeout(resolve, 2_000).unref();
      });
    const h = handler({
      concurrency: 2,
      run: async () => {
        active += 1;
        peak = Math.max(peak, active);
        await together();
        await sleep(20);
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

    // Upper bound: never more than `concurrency`. Lower bound: the executor did run two at once.
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
    const wakes = jest.spyOn(signals, 'wake');
    let ranAt: Date | undefined;
    const h = handler({
      run: async () => {
        ranAt = (await client.query<{ at: Date }>('select now() as at')).rows[0]?.at;
        return { resultRef: '/timer' };
      },
    });
    executor.register(h);
    // run_after on the database clock (the executor claims with `run_after <= now()`), so local clock
    // skew and Neon latency can't decide the outcome. Inserted through the repository: no wake signal.
    const { rows } = await client.query<{ at: Date }>(`select now() + interval '1500 milliseconds' as at`);
    const runAfter = rows[0]?.at ?? new Date(Date.now() + 1500);
    const { job } = await repo.enqueue({ type: h.type, idempotencyKey: randomUUID(), payload: { n: 1 }, runAfter });
    await executor.start();

    const done = await waitFor(job.id, ['succeeded'], 10_000);

    // Ordering, not timing: it ran no earlier than run_after, both on the database clock, with no signal.
    expect(ranAt?.getTime()).toBeGreaterThanOrEqual(runAfter.getTime());
    expect(done.attempts).toBe(1);
    expect(wakes).not.toHaveBeenCalled();
  });

  it('stop() waits for an in-flight pump, so no query outlives it and nothing is left running', async () => {
    const errors = jest.spyOn(Logger.prototype, 'error');
    const h = handler({ concurrency: 1, run: () => Promise.resolve({ resultRef: '/stop' }) });
    executor.register(h);
    await executor.start();
    const ids = await Promise.all(
      [1, 2, 3].map(async (n) => (await queue.enqueue({ type: h.type, idempotencyKey: randomUUID(), payload: { n } })).job.id),
    );

    // Stop while the wake-up pumps are still claiming; the client closes right after (afterEach).
    await executor.stop();
    await sleep(50);

    const statuses = await Promise.all(ids.map(async (id) => (await repo.findById(id))?.status));
    expect(statuses.every((st) => st === 'queued' || st === 'succeeded')).toBe(true);
    expect(errors.mock.calls.filter(([, msg]) => msg === 'Job pump failed')).toEqual([]);
    errors.mockRestore();
  });

  it('reschedules without using an attempt, runs again when due, and wakeWaiting makes it due at once', async () => {
    let runs = 0;
    const h = handler({
      run: (p) => {
        runs += 1;
        if (runs < 3) return Promise.reject(new RescheduleJob(runs === 1 ? 100 : 60 * 60_000, 'pool not ready'));
        return Promise.resolve({ resultRef: `/v1/paths/${p.n}` });
      },
    });
    executor.register(h);
    await executor.start();

    const { job } = await queue.enqueue({ type: h.type, idempotencyKey: randomUUID(), payload: { n: 4, topicId: 't-1' }, maxAttempts: 1 });
    // Run 1 waits 100 ms and runs again on the timer; run 2 waits an hour, so only a wake brings run 3.
    for (const until = Date.now() + 10_000; runs < 2; ) {
      if (Date.now() > until) throw new Error(`second run never happened: ${JSON.stringify(await repo.findById(job.id))}`);
      await sleep(25);
    }
    await executor.idle();
    const waiting = await repo.findById(job.id);
    expect(waiting).toMatchObject({ status: 'queued', attempts: 0, lockedAt: null });
    expect(await queue.wakeWaiting(h.type, { topicId: 'other' })).toBe(0);
    expect(await queue.wakeWaiting(h.type, { topicId: 't-1' })).toBe(1);

    // maxAttempts 1, yet it ran three times: waiting never used the attempt.
    expect(await waitFor(job.id, ['succeeded'])).toMatchObject({ attempts: 1, result: { resultRef: '/v1/paths/4' } });
    await executor.idle();
    expect(runs).toBe(3);
    expect(events.map((e) => e.type)).toEqual(['completed']);
  });

  it('fails a job that keeps waiting past maxWaitMs with SERVICE_UNAVAILABLE, then calls onDead once', async () => {
    const dead: { payload: { n: number }; jobId: string; error: unknown }[] = [];
    const h = handler({
      maxWaitMs: 300,
      run: () => Promise.reject(new RescheduleJob(100, 'pool for t-9 not ready')),
      onDead: (payload, info) => {
        dead.push({ payload, ...info });
        return Promise.resolve();
      },
    });
    executor.register(h);
    await executor.start();

    const { job } = await queue.enqueue({ type: h.type, idempotencyKey: randomUUID(), payload: { n: 9 } });
    const failed = await waitFor(job.id, ['dead']);
    await executor.idle();

    expect(failed.error).toMatch(/^Gave up waiting after 300 ms: pool for t-9 not ready$/);
    const event = events.find((e) => e.type === 'failed');
    expect(event?.data).toMatchObject({ jobId: job.id, retryable: false, problem: { code: 'SERVICE_UNAVAILABLE', status: 503, detail: 'Please try again later.' } });
    expect(JSON.stringify(event?.data)).not.toContain('t-9');
    expect(dead).toHaveLength(1);
    expect(dead[0]).toMatchObject({ payload: { n: 9 }, jobId: job.id });
  });

  it('calls onDead when attempts run out, not on a retry, and logs a throwing hook', async () => {
    const errors = jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    const calls: string[] = [];
    const h = handler({
      run: () => Promise.reject(new Error('upstream down')),
      onDead: (_p, info) => {
        calls.push(info.jobId);
        return Promise.reject(new Error('refund failed'));
      },
    });
    executor.register(h);
    await executor.start();

    const { job } = await queue.enqueue({ type: h.type, idempotencyKey: randomUUID(), payload: { n: 1 }, maxAttempts: 2 });
    await waitFor(job.id, ['dead']);
    await executor.idle();

    expect(calls).toEqual([job.id]);
    expect(errors.mock.calls.some(([, msg]) => msg === 'Job onDead hook failed')).toBe(true);
    errors.mockRestore();
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
