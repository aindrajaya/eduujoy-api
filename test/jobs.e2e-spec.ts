import { randomUUID } from 'node:crypto';
import { type AddressInfo } from 'node:net';
import { AccessTokenService } from '../src/shared/common/auth';
import { DATABASE, type Database } from '../src/shared/db';
import { users } from '../src/shared/db/schema/identity';
import { jobs } from '../src/shared/db/schema/jobs';
import { JobExecutor, JobQueue, JobRepository } from '../src/shared/jobs';
import { JOB_EVENTS_HEARTBEAT_MS } from '../src/shared/jobs/job-events.controller';
import { createTestApp, type TestApp } from './app';

jest.setTimeout(60_000);

interface Frame {
  id?: string;
  event?: string;
  data?: unknown;
  comment?: string;
}

/** Reads an SSE response until the server closes it or `untilMs` passes; returns the frames. */
async function readStream(res: Response, untilMs = 10_000, onFrame?: (f: Frame) => void): Promise<{ frames: Frame[]; closedByServer: boolean }> {
  const reader = (res.body as ReadableStream<Uint8Array>).getReader();
  const decoder = new TextDecoder();
  const frames: Frame[] = [];
  let buffer = '';
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    void reader.cancel();
  }, untilMs);
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let cut: number;
      while ((cut = buffer.indexOf('\n\n')) >= 0) {
        const block = buffer.slice(0, cut);
        buffer = buffer.slice(cut + 2);
        const frame: Frame = {};
        for (const line of block.split('\n')) {
          if (line.startsWith(':')) frame.comment = line.slice(1).trim();
          else if (line.startsWith('id: ')) frame.id = line.slice(4);
          else if (line.startsWith('event: ')) frame.event = line.slice(7);
          else if (line.startsWith('data: ')) frame.data = JSON.parse(line.slice(6));
        }
        frames.push(frame);
        onFrame?.(frame);
      }
    }
  } catch {
    // cancelled on timeout
  } finally {
    clearTimeout(timer);
  }
  return { frames, closedByServer: !timedOut };
}

describe('job events SSE (e2e, A9)', () => {
  let app: TestApp;
  let db: Database;
  let repo: JobRepository;
  let base: string;

  beforeAll(async () => {
    app = await createTestApp((builder) => builder.overrideProvider(JOB_EVENTS_HEARTBEAT_MS).useValue(300));
    await app.listen(0, '127.0.0.1');
    base = `http://127.0.0.1:${(app.getHttpServer().address() as AddressInfo).port}`;
    db = app.get<Database>(DATABASE);
    repo = app.get(JobRepository);
  });

  afterAll(async () => {
    await app.close();
  });

  async function signedInUser(): Promise<{ userId: string; cookie: string }> {
    const [user] = await db.insert(users).values({ email: `sse-${randomUUID()}@example.com` }).returning();
    const userId = user?.id ?? '';
    const token = await app.get(AccessTokenService).sign({ userId, sessionId: randomUUID(), roles: ['learner'], plan: 'free' });
    return { userId, cookie: `ej_at=${token}` };
  }

  /** A job of a type no handler runs, so the test writes its events itself. */
  async function job(userId: string | null) {
    return (await repo.enqueue({ type: 'sse-e2e-idle', idempotencyKey: randomUUID(), payload: {}, userId })).job;
  }

  const open = (id: string, cookie?: string, lastEventId?: string) =>
    fetch(`${base}/v1/jobs/${id}/events`, {
      headers: { ...(cookie ? { Cookie: cookie } : {}), ...(lastEventId ? { 'Last-Event-ID': lastEventId } : {}), Accept: 'text/event-stream' },
    });

  it('replays the stored events, streams live ones from the executor, and closes after completed', async () => {
    const { userId, cookie } = await signedInUser();
    const executor = app.get(JobExecutor);
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const type = `sse-e2e-${randomUUID().slice(0, 8)}`;
    executor.register({
      type,
      concurrency: 1,
      timeoutMs: 20_000,
      parse: (p) => p,
      run: async (_p, ctx) => {
        await ctx.progress('discover', 1, 2, 'Searching');
        await gate;
        await ctx.progress('design', 2, 2);
        return { resultRef: '/v1/paths/p-1' };
      },
    });
    const { job: running } = await app.get(JobQueue).enqueue({ type, idempotencyKey: randomUUID(), payload: {}, userId });
    for (const until = Date.now() + 10_000; (await repo.eventsAfter(running.id)).length === 0; ) {
      if (Date.now() > until) throw new Error('no first event');
      await new Promise((r) => setTimeout(r, 25));
    }

    const res = await open(running.id, cookie);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toMatch(/^text\/event-stream/);
    expect(res.headers.get('cache-control')).toBe('no-cache');
    expect(res.headers.get('x-accel-buffering')).toBe('no');
    expect(res.headers.get('content-encoding')).toBeNull();

    const read = readStream(res, 15_000, (f) => {
      if (f.event === 'progress' && (f.data as { stage: string }).stage === 'discover') release();
    });
    const { frames, closedByServer } = await read;
    const events = frames.filter((f) => f.event);
    expect(events.map((f) => [f.event, (f.data as { stage?: string }).stage ?? null])).toEqual([
      ['progress', 'discover'],
      ['progress', 'design'],
      ['completed', null],
    ]);
    expect(events.at(-1)?.data).toEqual({ jobId: running.id, resultRef: '/v1/paths/p-1' });
    const ids = events.map((f) => Number(f.id));
    expect([...ids].sort((a, b) => a - b)).toEqual(ids);
    expect(closedByServer).toBe(true);
  });

  it('replays only events after Last-Event-ID, sends heartbeats, and picks up events another instance wrote', async () => {
    const { userId, cookie } = await signedInUser();
    const j = await job(userId);
    const first = await repo.appendEvent(j.id, 'progress', { jobId: j.id, stage: 'discover', done: 1, total: 3 });
    await repo.appendEvent(j.id, 'progress', { jobId: j.id, stage: 'analyse', done: 2, total: 3 });

    const res = await open(j.id, cookie, String(first.id));
    let wrote = false;
    const { frames, closedByServer } = await readStream(res, 10_000, (f) => {
      // After the first heartbeat, write the terminal event straight to the table: this instance's
      // executor never hears of it, so only the heartbeat re-read can deliver it.
      if (f.comment === 'heartbeat' && !wrote) {
        wrote = true;
        void repo.appendEvent(j.id, 'completed', { jobId: j.id, resultRef: '/v1/paths/p-2' });
      }
    });
    expect(frames.filter((f) => f.event).map((f) => (f.data as { stage?: string }).stage ?? f.event)).toEqual(['analyse', 'completed']);
    expect(frames.some((f) => f.comment === 'heartbeat')).toBe(true);
    expect(closedByServer).toBe(true);
  });

  it('synthesises the terminal event of a finished job whose event is missing, then closes', async () => {
    const { userId, cookie } = await signedInUser();
    // Dead, but its `failed` event write never landed (a database blip at the wrong moment).
    const [target] = await db
      .insert(jobs)
      .values({ type: 'sse-e2e-idle', idempotencyKey: randomUUID(), payload: {}, userId, status: 'dead', error: 'secret internal reason' })
      .returning();
    if (!target) throw new Error('insert returned no row');

    const res = await open(target.id, cookie);
    const { frames, closedByServer } = await readStream(res, 5_000);
    const failed = frames.find((f) => f.event === 'failed');
    expect(failed?.data).toMatchObject({ jobId: target.id, retryable: false, problem: { code: 'INTERNAL', status: 500 } });
    expect(JSON.stringify(frames)).not.toContain('secret internal reason');
    expect(closedByServer).toBe(true);
  });

  it('is 404 for another learner, an unknown or malformed id, and 401 without a session', async () => {
    const owner = await signedInUser();
    const other = await signedInUser();
    const j = await job(owner.userId);

    expect((await open(j.id, other.cookie)).status).toBe(404);
    expect((await open(randomUUID(), owner.cookie)).status).toBe(404);
    expect((await open('not-a-uuid', owner.cookie)).status).toBe(404);
    const anonymous = await open(j.id);
    expect(anonymous.status).toBe(401);
    expect(anonymous.headers.get('content-type')).toMatch(/^application\/problem\+json/);
  });
});
