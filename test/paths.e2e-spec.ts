import { randomUUID } from 'node:crypto';
import { eq, sql } from 'drizzle-orm';
import request from 'supertest';
import { NonRetryableJobError } from '../src/shared/jobs';
import { FakePathDesigner, validSteps } from '../src/modules/pathing/application/pathing.fakes';
import { PATH_DESIGNER } from '../src/modules/pathing/application/ports/path-designer';
import { AiBudgetGuard, EMBEDDER, type Embedder } from '../src/shared/ai';
import { EMBEDDING_DIMENSIONS } from '../src/shared/db/schema/common';
import { AiBudgetExceededError } from '../src/shared/ai/errors';
import { AccessTokenService } from '../src/shared/common/auth';
import { DATABASE, type Database } from '../src/shared/db';
import { creditLedger } from '../src/shared/db/schema/billing';
import { paths, pathSteps } from '../src/shared/db/schema/pathing';
import { reviewItems } from '../src/shared/db/schema/admin';
import { JobRepository } from '../src/shared/jobs';
import { FakeLinkChecker, FakeWebDiscovery } from '../src/modules/discovery/application/discovery.fakes';
import { LINK_CHECKER } from '../src/modules/discovery/application/ports/link-checker';
import { WEB_DISCOVERY } from '../src/modules/discovery/application/ports/web-discovery';
import { topics } from '../src/shared/db/schema/catalog';
import { ReservePath } from '../src/modules/billing/application/reserve-path.usecase';
import { PathRefundSweep } from '../src/modules/pathing/application/path-refund-sweep.handler';
import { ReviewResolved } from '../src/shared/common/review';
import { EventBus } from '../src/shared/events';
import { createTestApp, type TestApp } from './app';
import { learner, placement, readyPool, topic } from './pathing/fixtures';

jest.setTimeout(60_000);

const csrf = { Origin: 'http://localhost:5173', 'X-Requested-With': 'eduujoy' };
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

interface Accepted {
  jobId: string;
  status: string;
  eventsUrl: string;
}

describe('paths (e2e, PRD-API §13 A9 Verify)', () => {
  let app: TestApp;
  let db: Database;
  let designer: FakePathDesigner;

  beforeAll(async () => {
    designer = new FakePathDesigner();
    app = await createTestApp((b) => b.overrideProvider(PATH_DESIGNER).useValue(designer));
    db = app.get<Database>(DATABASE);
  });

  afterAll(async () => {
    await app.close();
  });

  const http = () => request(app.getHttpServer());

  async function signedIn(): Promise<{ userId: string; cookie: string }> {
    const userId = await learner(db);
    const token = await app.get(AccessTokenService).sign({ userId, sessionId: randomUUID(), roles: ['learner'], plan: 'free' });
    return { userId, cookie: `ej_at=${token}` };
  }

  /** A learner placed at advanced_beginner C3 on a topic whose two pools are ready. */
  async function ready(): Promise<{ userId: string; cookie: string; topicId: string; placementId: string }> {
    const user = await signedIn();
    const topicId = await topic(db);
    await readyPool(db, topicId, 'advanced_beginner', 3);
    await readyPool(db, topicId, 'competent', 4);
    return { ...user, topicId, placementId: await placement(db, user.userId, topicId) };
  }

  const post = (cookie: string, body: object, key = `key-${randomUUID()}`) =>
    http().post('/v1/paths').set(csrf).set('Cookie', cookie).set('Idempotency-Key', key).send(body);

  async function settled(jobId: string): Promise<string> {
    const jobs = app.get(JobRepository);
    for (const until = Date.now() + 30_000; ; ) {
      const job = await jobs.findById(jobId);
      if (job && (job.status === 'succeeded' || job.status === 'dead')) return job.status;
      if (Date.now() > until) throw new Error(`job ${jobId} stuck in ${job?.status ?? 'missing'}`);
      await sleep(50);
    }
  }

  const pathOf = async (jobId: string) => (await db.select().from(paths).where(eq(paths.jobId, jobId)))[0];
  const balance = async (userId: string) => (await db.select({ d: creditLedger.delta }).from(creditLedger).where(eq(creditLedger.userId, userId))).reduce((n, r) => n + r.d, 0);

  it('accepts a request, builds the path on ready pools, and serves it with ETags', async () => {
    const { cookie, placementId } = await ready();

    const res = await post(cookie, { placementId, weeklyHours: 5 });
    expect(res.status).toBe(202);
    const accepted = res.body as Accepted;
    expect(accepted).toEqual({ jobId: expect.any(String) as string, status: 'queued', eventsUrl: `/v1/jobs/${accepted.jobId}/events` });
    const path = await pathOf(accepted.jobId);
    // 404 while generating would race the fast fake designer; check the settled path instead.
    expect(await settled(accepted.jobId)).toBe('succeeded');

    const got = await http().get(`/v1/paths/${path?.id ?? ''}`).set('Cookie', cookie);
    expect(got.status).toBe(200);
    expect(got.body).toMatchObject({ id: path?.id, status: 'active', from: { stage: 'advanced_beginner', bloom: 'C3' }, to: { stage: 'competent', bloom: 'C4' }, stepsTotal: 6, stepsDone: 0 });
    const steps = (got.body as { steps: { n: number; status: string; resources: { id: string; title: string }[]; checkpoint: object }[] }).steps;
    expect(steps.map((s) => s.status)).toEqual(['active', 'locked', 'locked', 'locked', 'locked', 'locked']);
    expect(steps[0]?.resources[0]?.title).toBe('advanced_beginner resource 1');
    expect(JSON.stringify(got.body)).not.toMatch(/correctOptionIds|expectedAnswer|answerKeys/);
    // The designer saw the learner's override of their weekly hours.
    expect(designer.requests.at(-1)).toMatchObject({ weeklyHours: 5, budgetMinutes: 600, target: 'competent' });

    const etag = got.headers['etag'] as string;
    expect(etag).toBeTruthy();
    expect((await http().get(`/v1/paths/${path?.id ?? ''}`).set('Cookie', cookie).set('If-None-Match', etag)).status).toBe(304);

    const list = await http().get('/v1/paths?status=active').set('Cookie', cookie);
    expect(list.status).toBe(200);
    expect(list.body).toMatchObject({ items: [{ id: path?.id, currentStep: { n: 1, status: 'active' }, topic: { id: path?.topicId } }], nextCursor: null });
    const listTag = list.headers['etag'] as string;
    expect((await http().get('/v1/paths?status=active').set('Cookie', cookie).set('If-None-Match', listTag)).status).toBe(304);
    // Progress changes the body, so the old tags stop matching.
    await http().patch(`/v1/steps/${(got.body as { steps: { id: string }[] }).steps[0]?.id ?? ''}`).set(csrf).set('Cookie', cookie).send({ status: 'completed' });
    expect((await http().get('/v1/paths?status=active').set('Cookie', cookie).set('If-None-Match', listTag)).status).toBe(200);
    expect((await http().get(`/v1/paths/${path?.id ?? ''}`).set('Cookie', cookie).set('If-None-Match', etag)).status).toBe(200);
  });

  it("exports the learner's paths and steps without checkpoint answer keys", async () => {
    const { cookie, placementId } = await ready();
    const accepted = (await post(cookie, { placementId })).body as Accepted;
    await settled(accepted.jobId);
    const path = await pathOf(accepted.jobId);

    const res = await http().get('/v1/me/export').set('Origin', 'http://localhost:5173').set('Cookie', cookie);
    expect(res.status).toBe(200);
    const pathing = (res.body as { pathing: { paths: { id: string }[]; steps: { pathId: string }[] } }).pathing;
    expect(pathing.paths.map((p) => p.id)).toEqual([path?.id]);
    expect(pathing.steps).toHaveLength(6);
    expect(JSON.stringify(pathing)).not.toMatch(/correctOptionIds|expectedAnswer|answerKeys/);
  });

  it('replays a key, rejects a reused key with another body, and joins a second request for the placement', async () => {
    const { cookie, placementId } = await ready();
    const key = `key-${randomUUID()}`;

    const first = await post(cookie, { placementId }, key);
    const again = await post(cookie, { placementId }, key);
    expect(again.status).toBe(202);
    expect(again.body).toEqual(first.body);
    const mismatch = await post(cookie, { placementId, goal: 'something else' }, key);
    expect(mismatch.status).toBe(409);
    expect(mismatch.body).toMatchObject({ code: 'IDEMPOTENCY_MISMATCH' });
    const other = await post(cookie, { placementId });
    expect(other.status).toBe(202);
    expect((other.body as Accepted).jobId).toBe((first.body as Accepted).jobId);
    await settled((first.body as Accepted).jobId);
  });

  it("is 404 for another learner's placement and path, and charges nothing", async () => {
    const owner = await ready();
    const stranger = await signedIn();

    const res = await post(stranger.cookie, { placementId: owner.placementId });
    expect(res.status).toBe(404);
    expect(res.body).toMatchObject({ code: 'NOT_FOUND' });
    expect((await post(stranger.cookie, { placementId: 'not-a-uuid' })).status).toBe(404);
    expect(await balance(stranger.userId)).toBe(0);
    expect((await db.select().from(creditLedger).where(eq(creditLedger.userId, stranger.userId))).length).toBe(0);

    const mine = (await post(owner.cookie, { placementId: owner.placementId })).body as Accepted;
    await settled(mine.jobId);
    const path = await pathOf(mine.jobId);
    expect((await http().get(`/v1/paths/${path?.id ?? ''}`).set('Cookie', stranger.cookie)).status).toBe(404);
  });

  it('is 402 once the allowance and credits are used, and 400 without an Idempotency-Key', async () => {
    const { cookie, userId, topicId } = await ready();
    const one = await post(cookie, { placementId: await placement(db, userId, topicId) });
    expect(one.status).toBe(202);
    await settled((one.body as Accepted).jobId);

    const two = await post(cookie, { placementId: await placement(db, userId, topicId) });
    expect(two.status).toBe(402);
    expect(two.body).toMatchObject({ code: 'QUOTA_EXCEEDED' });
    const noKey = await http().post('/v1/paths').set(csrf).set('Cookie', cookie).send({ placementId: await placement(db, userId, topicId) });
    expect(noKey.status).toBe(400);
  });

  it('limits a learner to 5 paths an hour', async () => {
    const { cookie, userId, topicId, placementId } = await ready();
    for (let i = 0; i < 5; i += 1) {
      await db.insert(paths).values({ userId, topicId, fromStage: 'advanced_beginner', fromBloom: 'C3', toStage: 'competent', toBloom: 'C4', status: 'failed' });
    }
    const res = await post(cookie, { placementId });
    expect(res.status).toBe(429);
    expect(res.body).toMatchObject({ code: 'RATE_LIMITED' });
    expect(res.headers['retry-after']).toBe('3600');
  });

  it('sends a path that fails validation twice to review, and the job still completes', async () => {
    const { cookie, placementId, topicId } = await ready();
    const broken = validSteps({ placement: { stage: 'advanced_beginner', bloom: 'C3' }, target: 'competent', budgetMinutes: 480, cards: [] } as never).map((s) => ({ ...s, resources: ['r99'] }));
    const [named] = await db.select({ name: topics.canonicalName }).from(topics).where(eq(topics.id, topicId));
    designer.byTopic.set(named?.name ?? '', [broken, broken]);

    const accepted = (await post(cookie, { placementId })).body as Accepted;
    expect(await settled(accepted.jobId)).toBe('succeeded');
    const path = await pathOf(accepted.jobId);
    expect(path?.status).toBe('under_review');
    expect(await db.select().from(pathSteps).where(eq(pathSteps.pathId, path?.id ?? ''))).toEqual([]);
    const [flag] = await db.select().from(reviewItems).where(eq(reviewItems.targetId, path?.id ?? ''));
    expect(flag).toMatchObject({ kind: 'path', reason: 'validation_failed' });
    expect((await http().get(`/v1/paths/${path?.id ?? ''}`).set('Cookie', cookie)).body).toMatchObject({ status: 'under_review' });
  });

  it('refunds the charge when the job dies, and the placement can be requested again', async () => {
    const { cookie, userId, placementId } = await ready();
    const failing = designer.design.bind(designer);
    designer.design = () => Promise.reject(new NonRetryableJobError('designer refused'));
    try {
      const accepted = (await post(cookie, { placementId })).body as Accepted;
      expect(await settled(accepted.jobId)).toBe('dead');
      for (const until = Date.now() + 10_000; !(await pathOf(accepted.jobId))?.refundedAt; ) {
        if (Date.now() > until) throw new Error('never refunded');
        await sleep(50);
      }
      const path = await pathOf(accepted.jobId);
      expect(path?.status).toBe('failed');
      const rows = await db.select({ reason: creditLedger.reason, delta: creditLedger.delta }).from(creditLedger).where(eq(creditLedger.userId, userId));
      expect(rows.map((r) => r.reason).sort()).toEqual(['path', 'refund']);
    } finally {
      designer.design = failing;
    }
    // The refunded plan slot is free again, and a failed path doesn't block its placement.
    const retry = await post(cookie, { placementId });
    expect(retry.status).toBe(202);
    expect(await settled((retry.body as Accepted).jobId)).toBe('succeeded');
  });

  it('fails and refunds a path whose cold pool finds nothing usable', async () => {
    const { userId, cookie } = await signedIn();
    const topicId = await topic(db);
    // The default fakes find no resources, so the new pool settles empty.
    const placementId = await placement(db, userId, topicId, { stage: 'novice', bloom: 'C1' });

    const accepted = (await post(cookie, { placementId })).body as Accepted;
    expect(await settled(accepted.jobId)).toBe('dead');
    const job = await app.get(JobRepository).findById(accepted.jobId);
    expect(job?.error).toBe('No usable resources for this topic and stage');
    for (const until = Date.now() + 10_000; !(await pathOf(accepted.jobId))?.refundedAt; ) {
      if (Date.now() > until) throw new Error('never refunded');
      await sleep(50);
    }
  });

  it('marks actions, unlocks the next step on completion, and validates the patch', async () => {
    const { cookie, placementId } = await ready();
    const accepted = (await post(cookie, { placementId })).body as Accepted;
    await settled(accepted.jobId);
    const path = await pathOf(accepted.jobId);
    const steps = (await http().get(`/v1/paths/${path?.id ?? ''}`).set('Cookie', cookie)).body as { steps: { id: string }[] };
    const [first, second] = steps.steps;

    const marked = await http().patch(`/v1/steps/${first?.id ?? ''}`).set(csrf).set('Cookie', cookie).send({ actionsDone: [{ n: 1, done: true }], difficulty: 'ok' });
    expect(marked.status).toBe(200);
    expect(marked.body).toMatchObject({ id: first?.id, status: 'active', difficulty: 'ok', actions: [{ n: 1, done: true }], resources: [{ id: expect.any(String) as string }] });
    expect((await http().patch(`/v1/steps/${second?.id ?? ''}`).set(csrf).set('Cookie', cookie).send({ status: 'completed' })).status).toBe(400);
    expect((await http().patch(`/v1/steps/${first?.id ?? ''}`).set(csrf).set('Cookie', cookie).send({})).status).toBe(400);
    const stranger = await signedIn();
    expect((await http().patch(`/v1/steps/${first?.id ?? ''}`).set(csrf).set('Cookie', stranger.cookie).send({ difficulty: 'ok' })).status).toBe(404);

    expect((await http().patch(`/v1/steps/${first?.id ?? ''}`).set(csrf).set('Cookie', cookie).send({ status: 'completed' })).body).toMatchObject({ status: 'completed' });
    const after = (await http().get(`/v1/paths/${path?.id ?? ''}`).set('Cookie', cookie)).body as { stepsDone: number; currentStep: { id: string } };
    expect(after).toMatchObject({ stepsDone: 1, currentStep: { id: second?.id } });
  });
});

describe('path refunds (e2e, user decision 23 Oct 2026)', () => {
  let app: TestApp;
  let db: Database;

  beforeAll(async () => {
    app = await createTestApp();
    db = app.get<Database>(DATABASE);
  });

  afterAll(async () => {
    await app.close();
  });

  /** A charged path in `status`, created `ageMs` ago, with an optional job in `jobStatus`. */
  async function chargedPath(status: 'generating' | 'active' | 'failed' | 'under_review', ageMs = 0, jobStatus?: 'queued' | 'dead') {
    const userId = await learner(db);
    const topicId = await topic(db);
    const placementId = await placement(db, userId, topicId);
    const at = new Date(Date.now() - ageMs);
    let jobId: string | null = null;
    if (jobStatus) {
      const { job } = await app.get(JobRepository).enqueue({ type: 'sweep-e2e-idle', idempotencyKey: randomUUID(), payload: {}, userId });
      await db.execute(sql`update jobs set status = ${jobStatus} where id = ${job.id}`);
      jobId = job.id;
    }
    const [row] = await db
      .insert(paths)
      .values({ userId, topicId, placementId, fromStage: 'advanced_beginner', fromBloom: 'C3', toStage: 'competent', toBloom: 'C4', status, jobId, createdAt: at, updatedAt: at })
      .returning({ id: paths.id });
    const pathId = row?.id ?? '';
    await app.get(ReservePath).execute(userId, pathId);
    // ReservePath's own writes don't touch the path; restore the age the sweep compares.
    await db.update(paths).set({ updatedAt: at }).where(eq(paths.id, pathId));
    return { userId, pathId };
  }

  const refundRows = async (userId: string) => (await db.select().from(creditLedger).where(eq(creditLedger.userId, userId))).filter((r) => r.reason === 'refund');
  const pathRow = async (pathId: string) => (await db.select().from(paths).where(eq(paths.id, pathId)))[0];

  it('refunds a path left in review past 48 hours once, and keeps it in review', async () => {
    const late = await chargedPath('under_review', 49 * 3600_000);
    const recent = await chargedPath('under_review', 47 * 3600_000);
    const sweep = app.get(PathRefundSweep);

    await sweep.sweep(new Date());
    await sweep.sweep(new Date());
    expect(await refundRows(late.userId)).toHaveLength(1);
    expect(await pathRow(late.pathId)).toMatchObject({ status: 'under_review', refundedAt: expect.any(Date) as Date });
    expect(await refundRows(recent.userId)).toEqual([]);
  });

  it("finishes refunds a dead job's onDead missed, and leaves a waiting job alone", async () => {
    const failed = await chargedPath('failed');
    const stuck = await chargedPath('generating', 3 * 3600_000, 'dead');
    const waiting = await chargedPath('generating', 3 * 3600_000, 'queued');
    const young = await chargedPath('generating', 60_000, 'dead');
    const sweep = app.get(PathRefundSweep);

    await sweep.sweep(new Date());
    await sweep.sweep(new Date());
    expect(await refundRows(failed.userId)).toHaveLength(1);
    expect(await refundRows(stuck.userId)).toHaveLength(1);
    expect(await pathRow(stuck.pathId)).toMatchObject({ status: 'failed', refundedAt: expect.any(Date) as Date });
    expect(await refundRows(waiting.userId)).toEqual([]);
    expect(await refundRows(young.userId)).toEqual([]);
  });

  it('refunds and fails a path a reviewer rejects, held or active, and ignores approvals', async () => {
    const held = await chargedPath('under_review');
    const active = await chargedPath('active');
    const approved = await chargedPath('under_review');
    const bus = app.get(EventBus);

    await bus.publish(new ReviewResolved(randomUUID(), 'path', held.pathId, 'rejected'));
    await bus.publish(new ReviewResolved(randomUUID(), 'path', held.pathId, 'rejected'));
    await bus.publish(new ReviewResolved(randomUUID(), 'path', active.pathId, 'rejected'));
    await bus.publish(new ReviewResolved(randomUUID(), 'path', approved.pathId, 'approved'));
    expect(await refundRows(held.userId)).toHaveLength(1);
    expect(await pathRow(held.pathId)).toMatchObject({ status: 'failed', refundedAt: expect.any(Date) as Date });
    expect(await pathRow(active.pathId)).toMatchObject({ status: 'failed' });
    expect(await refundRows(active.userId)).toHaveLength(1);
    expect(await pathRow(approved.pathId)).toMatchObject({ status: 'under_review', refundedAt: null });
  });
});

describe('paths when the AI budget is spent (e2e)', () => {
  let app: TestApp;
  let db: Database;

  beforeAll(async () => {
    const guard = { assertCanStart: () => Promise.reject(new AiBudgetExceededError(3.2, 3)), status: () => Promise.resolve({ exceeded: true }) };
    app = await createTestApp((b) => b.overrideProvider(AiBudgetGuard).useValue(guard));
    db = app.get<Database>(DATABASE);
  });

  afterAll(async () => {
    await app.close();
  });

  it('is 503 with Retry-After and charges nothing', async () => {
    const userId = await learner(db);
    const token = await app.get(AccessTokenService).sign({ userId, sessionId: randomUUID(), roles: ['learner'], plan: 'free' });
    const placementId = await placement(db, userId, await topic(db));

    const res = await request(app.getHttpServer()).post('/v1/paths').set(csrf).set('Cookie', `ej_at=${token}`).set('Idempotency-Key', `key-${randomUUID()}`).send({ placementId });
    expect(res.status).toBe(503);
    expect(res.body).toMatchObject({ code: 'AI_BUDGET_EXCEEDED' });
    expect(Number(res.headers['retry-after'])).toBeGreaterThan(0);
    expect(await db.select().from(creditLedger).where(eq(creditLedger.userId, userId))).toEqual([]);
    expect(await db.select().from(paths).where(eq(paths.userId, userId))).toEqual([]);
  });
});

/** Distinct unit vectors, so discovery's near-duplicate check keeps every card. */
const embedder: Embedder = {
  embed: (r) => {
    const vectors = r.texts.map(() => {
      const v = Array.from({ length: EMBEDDING_DIMENSIONS }, () => Math.random() - 0.5);
      const norm = Math.sqrt(v.reduce((n, x) => n + x * x, 0));
      return v.map((x) => x / norm);
    });
    const usage = { inputTokens: 1, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 };
    return Promise.resolve({ vectors, model: 'gemini-embedding-2', version: 1, call: { provider: 'google' as const, model: 'gemini-embedding-2', usage, latencyMs: 1 } });
  },
};

describe('paths on a cold pool (e2e)', () => {
  let app: TestApp;
  let db: Database;
  const web = new FakeWebDiscovery();

  beforeAll(async () => {
    app = await createTestApp((b) =>
      b.overrideProvider(WEB_DISCOVERY).useValue(web).overrideProvider(LINK_CHECKER).useValue(new FakeLinkChecker(200)).overrideProvider(EMBEDDER).useValue(embedder),
    );
    db = app.get<Database>(DATABASE);
  });

  afterAll(async () => {
    await app.close();
  });

  it('waits while discovery builds the pool, wakes on ResourcesReady, and completes without spending an attempt', async () => {
    const userId = await learner(db);
    const token = await app.get(AccessTokenService).sign({ userId, sessionId: randomUUID(), roles: ['learner'], plan: 'free' });
    const topicId = await topic(db);
    const [row] = await db.select({ name: topics.canonicalName }).from(topics).where(eq(topics.id, topicId));
    web.finds.set(row?.name ?? '', [
      { url: `https://example.com/${randomUUID()}`, title: 'Getting started', pageAge: null, type: 'official_doc' },
      { url: `https://example.com/${randomUUID()}`, title: 'A beginner article', pageAge: null, type: 'article' },
      { url: `https://example.com/${randomUUID()}`, title: 'Related notes', pageAge: null, type: 'related' },
    ]);
    const placementId = await placement(db, userId, topicId, { stage: 'novice', bloom: 'C1' });

    const res = await request(app.getHttpServer()).post('/v1/paths').set(csrf).set('Cookie', `ej_at=${token}`).set('Idempotency-Key', `key-${randomUUID()}`).send({ placementId });
    expect(res.status).toBe(202);
    const { jobId } = res.body as Accepted;
    const jobs = app.get(JobRepository);
    for (const until = Date.now() + 40_000; ; ) {
      const job = await jobs.findById(jobId);
      if (job?.status === 'succeeded') break;
      if (job?.status === 'dead' || Date.now() > until) {
        const pools = await db.execute(sql`select status, candidate_ids, analysed_ids, resource_ids from discovery_results where topic_id = ${topicId}`);
        const cards = await db.execute(sql`select c.status, c.review_reason, r.type, r.dead_at from resource_cards c join resources r on r.id = c.resource_id where c.topic_id = ${topicId}`);
        throw new Error(`job ended ${job?.status ?? 'missing'}: ${job?.error ?? ''} ${JSON.stringify({ pools: pools.rows, cards: cards.rows })}`);
      }
      await sleep(100);
    }
    const [path] = await db.select().from(paths).where(eq(paths.jobId, jobId));
    expect(path).toMatchObject({ status: 'active', toStage: 'novice', toBloom: 'C2' });
    const events = await jobs.eventsAfter(jobId);
    expect(events.map((e) => (e.data as { stage?: string; kind?: string }).stage ?? (e.data as { kind?: string }).kind ?? e.type)).toEqual(
      expect.arrayContaining(['discover', 'design', 'validate', 'path_step', 'completed']),
    );
    expect((await jobs.findById(jobId))?.attempts).toBe(1);
  });
});

