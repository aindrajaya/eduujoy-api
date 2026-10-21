import { randomUUID } from 'node:crypto';
import { eq, inArray } from 'drizzle-orm';
import request from 'supertest';
import { cellIndex } from '../src/modules/assessment/domain/diagnostic';
import { AccessTokenService } from '../src/shared/common/auth';
import { DATABASE, type Database } from '../src/shared/db';
import { diagnosticAnswers, diagnosticItems, placements } from '../src/shared/db/schema/assessment';
import { topics } from '../src/shared/db/schema/catalog';
import { users } from '../src/shared/db/schema/identity';
import { learnerPositions } from '../src/shared/db/schema/progress';
import { loadSeed } from '../src/shared/db/seed/load-seed';
import { parseSeed } from '../src/shared/db/seed/seed-data';
import { createTestApp, type TestApp } from './app';
import { fixtureBankSeed } from './fixtures/diagnostic/bank';
import { answerFor, FIXTURE_LEARNERS } from './fixtures/diagnostic/learner';
import { secretKeyPaths } from './leaks';

const csrf = { Origin: 'http://localhost:5173', 'X-Requested-With': 'eduujoy' };

interface BatchBody {
  diagnosticId: string;
  status: 'in_progress' | 'completed';
  progress: { answered: number; estimatedTotal: number };
  items?: { id: string; kind: string; bloom: string; prompt: string; options?: { id: string }[] }[];
  placement?: { id: string; position: { stage: string; bloom: string }; confidence: number; reason: string };
}

describe('diagnostics (e2e, PRD-API §13 A7 Verify)', () => {
  let app: TestApp;
  let db: Database;
  let topicId: string;
  let emptyTopicId: string;
  let keys: Map<string, { cell: number; answerKey: string[] }>;

  beforeAll(async () => {
    app = await createTestApp();
    db = app.get<Database>(DATABASE);
    const slug = `diag-e2e-${randomUUID().slice(0, 8)}`;
    await loadSeed(db, parseSeed(fixtureBankSeed(slug, 'Diagnostic e2e topic')));
    const [topic] = await db.select().from(topics).where(eq(topics.slug, slug));
    topicId = topic?.id ?? '';
    const [empty] = await db.insert(topics).values({ slug: `${slug}-empty`, canonicalName: 'No bank yet' }).returning();
    emptyTopicId = empty?.id ?? '';
    // The test plays the learner, so it reads the answer keys straight from the database.
    const rows = await db.select().from(diagnosticItems).where(eq(diagnosticItems.topicId, topicId));
    keys = new Map(
      rows.map((r) => [r.id, { cell: cellIndex(r.stage, r.bloom), answerKey: (r.body as { answerKey: { optionIds: string[] } }).answerKey.optionIds }]),
    );
  });

  afterAll(async () => {
    await app.close();
  });

  const http = () => request(app.getHttpServer());

  async function signedInUser(): Promise<{ userId: string; cookie: string }> {
    const [user] = await db.insert(users).values({ email: `diag-${randomUUID()}@example.com` }).returning();
    const userId = user?.id ?? '';
    const token = await app.get(AccessTokenService).sign({ userId, sessionId: randomUUID(), roles: ['learner'], plan: 'free' });
    return { userId, cookie: `ej_at=${token}` };
  }

  const start = (cookie: string, body: Record<string, unknown>) => http().post('/v1/diagnostics').set(csrf).set('Cookie', cookie).send(body);
  const answer = (cookie: string, id: string, answers: unknown[], idempotencyKey?: string) =>
    http()
      .post(`/v1/diagnostics/${id}/answers`)
      .set(csrf)
      .set('Cookie', cookie)
      .set(idempotencyKey === undefined ? {} : { 'Idempotency-Key': idempotencyKey })
      .send({ answers });
  const recorded = async (sessionId: string) => (await db.select().from(diagnosticAnswers).where(eq(diagnosticAnswers.sessionId, sessionId))).length;

  it.each(FIXTURE_LEARNERS.map((l) => [l.name, l] as const))('places fixture learner %s as expected', async (_name, learner) => {
    const { userId, cookie } = await signedInUser();
    let res = await start(cookie, { topicId, goal: 'Get productive', weeklyHours: 4, ...(learner.selfReport ? { selfReport: learner.selfReport } : {}) }).expect(201);
    const seen = new Map<number, number>();
    let served = 0;
    let scenarios = 0;
    for (;;) {
      const body = res.body as BatchBody;
      expect(secretKeyPaths(body)).toEqual([]);
      expect(JSON.stringify(body)).not.toContain('answerKey');
      if (body.status === 'completed') break;
      const items = body.items ?? [];
      expect(items.length).toBeGreaterThan(0);
      expect(items.length).toBeLessThanOrEqual(4);
      served += items.length;
      scenarios += items.filter((i) => i.kind === 'scenario').length;
      const answers = items.map((i) => {
        const key = keys.get(i.id);
        if (!key) throw new Error(`unknown item ${i.id}`);
        return { itemId: i.id, optionIds: answerFor(learner, seen, key.cell, key.answerKey) };
      });
      res = await answer(cookie, body.diagnosticId, answers).expect(200);
    }

    const done = res.body as BatchBody;
    expect(served).toBeGreaterThanOrEqual(8);
    expect(served).toBeLessThanOrEqual(12);
    expect(scenarios).toBeGreaterThanOrEqual(1);
    expect(done.progress).toEqual({ answered: served, estimatedTotal: served });
    expect(done.placement?.position).toEqual({ stage: learner.expected.stage, bloom: learner.expected.bloom });
    expect(done.placement?.confidence).toBeGreaterThanOrEqual(learner.expected.minConfidence);
    expect(done.placement?.confidence).toBeLessThanOrEqual(learner.expected.maxConfidence);
    expect(done.placement?.reason.length).toBeGreaterThan(10);

    // PlacementComputed → progress recorded the learner's position.
    const positions = await db.select().from(learnerPositions).where(eq(learnerPositions.userId, userId));
    expect(positions).toEqual([expect.objectContaining({ topicId, stage: learner.expected.stage, bloom: learner.expected.bloom, source: 'diagnostic' })]);
  });

  it('resumes the open diagnostic and serves it on GET to the owner only', async () => {
    const owner = await signedInUser();
    const other = await signedInUser();
    const first = (await start(owner.cookie, { topicId, goal: 'Resume me', weeklyHours: 2 }).expect(201)).body as BatchBody;

    const again = (await start(owner.cookie, { topicId, goal: 'Resume me', weeklyHours: 2 }).expect(201)).body as BatchBody;
    expect(again.diagnosticId).toBe(first.diagnosticId);
    expect(again.items?.map((i) => i.id)).toEqual(first.items?.map((i) => i.id));

    const got = await http().get(`/v1/diagnostics/${first.diagnosticId}`).set('Cookie', owner.cookie).expect(200);
    expect(got.body).toMatchObject({
      diagnosticId: first.diagnosticId,
      status: 'in_progress',
      topic: { id: topicId, canonicalName: 'Diagnostic e2e topic' },
      completedAt: null,
    });
    expect((got.body as { createdAt: string }).createdAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);

    await http().get(`/v1/diagnostics/${first.diagnosticId}`).set('Cookie', other.cookie).expect(404);
    await http().get('/v1/diagnostics/not-a-uuid').set('Cookie', owner.cookie).expect(404);
    // Answering someone else's diagnostic is 404 too, so ids aren't probeable.
    const skipped = (first.items ?? []).map((i) => ({ itemId: i.id, skipped: true }));
    await answer(other.cookie, first.diagnosticId, skipped).expect(404);
    await answer(owner.cookie, 'not-a-uuid', skipped).expect(404);
  });

  it('answers 409 for a mismatched batch and for a finished diagnostic', async () => {
    const { cookie } = await signedInUser();
    let body = (await start(cookie, { topicId, goal: 'Conflicts', weeklyHours: 2 }).expect(201)).body as BatchBody;
    const items = body.items ?? [];

    const mismatch = await answer(cookie, body.diagnosticId, items.slice(1).map((i) => ({ itemId: i.id, skipped: true }))).expect(409);
    expect((mismatch.body as { code: string }).code).toBe('CONFLICT');

    while (body.status === 'in_progress') {
      body = (await answer(cookie, body.diagnosticId, (body.items ?? []).map((i) => ({ itemId: i.id, skipped: true }))).expect(200)).body as BatchBody;
    }
    expect(body.placement?.position).toEqual({ stage: 'novice', bloom: 'C1' });
    await answer(cookie, body.diagnosticId, items.map((i) => ({ itemId: i.id, skipped: true }))).expect(409);
    const got = await http().get(`/v1/diagnostics/${body.diagnosticId}`).set('Cookie', cookie).expect(200);
    expect(got.body).toMatchObject({ status: 'completed', placement: { id: body.placement?.id } });
    expect((got.body as { items?: unknown }).items).toBeUndefined();
  });

  it('replays a retried batch with the same Idempotency-Key and rejects a reused key with another body (contract 0.3.0)', async () => {
    const { cookie } = await signedInUser();
    let body = (await start(cookie, { topicId, goal: 'Retries', weeklyHours: 2 }).expect(201)).body as BatchBody;
    const skipAll = (b: BatchBody) => (b.items ?? []).map((i) => ({ itemId: i.id, skipped: true }));
    const key = `retry-${randomUUID()}`;

    const first = (await answer(cookie, body.diagnosticId, skipAll(body), key).expect(200)).body as BatchBody;
    const retry = await answer(cookie, body.diagnosticId, skipAll(body), key).expect(200);
    expect(retry.body).toEqual(first);
    expect(await recorded(body.diagnosticId)).toBe(4);

    const reused = await answer(cookie, body.diagnosticId, skipAll(first), key).expect(409);
    expect((reused.body as { code: string }).code).toBe('CONFLICT');
    expect(await recorded(body.diagnosticId)).toBe(4);

    // Concurrent retries of one batch serialise on the session lock: one records, the other replays.
    const [one, two] = await Promise.all([answer(cookie, body.diagnosticId, skipAll(first), `${key}-2`), answer(cookie, body.diagnosticId, skipAll(first), `${key}-2`)]);
    expect([one.status, two.status]).toEqual([200, 200]);
    expect(one.body).toEqual(two.body);
    expect(await recorded(body.diagnosticId)).toBe(8);

    // The final batch replays its placement after the diagnostic completes.
    let last = `${key}-2`;
    let lastAnswers: unknown[] = skipAll(first);
    body = one.body as BatchBody;
    while (body.status === 'in_progress') {
      last = `${key}-${body.progress.answered}`;
      lastAnswers = skipAll(body);
      body = (await answer(cookie, body.diagnosticId, lastAnswers, last).expect(200)).body as BatchBody;
    }
    const replayed = await answer(cookie, body.diagnosticId, lastAnswers, last).expect(200);
    expect(replayed.body).toEqual(body);
    expect(await db.select().from(placements).where(eq(placements.sessionId, body.diagnosticId))).toHaveLength(1);

    for (const bad of ['short', 'k'.repeat(129)]) {
      const res = await answer(cookie, body.diagnosticId, lastAnswers, bad).expect(400);
      expect((res.body as { errors: { field: string }[] }).errors[0]?.field).toBe('Idempotency-Key');
    }
  });

  it('places from the self-report at once, flagged, when the topic has no item bank', async () => {
    const { userId, cookie } = await signedInUser();

    const res = await start(cookie, { topicId: emptyTopicId, goal: 'No bank', weeklyHours: 3, selfReport: { years: 6 } }).expect(201);

    expect(res.body).toMatchObject({
      status: 'completed',
      progress: { answered: 0, estimatedTotal: 0 },
      placement: { position: { stage: 'proficient', bloom: 'C4' }, confidence: 0.3 },
    });
    const [row] = await db.select().from(placements).where(inArray(placements.userId, [userId]));
    expect(row?.basis).toBe('self_report');
  });

  it('validates input: unknown topic 404, bounds and unknown fields 400, CSRF 403, auth 401', async () => {
    const { cookie } = await signedInUser();

    await start(cookie, { topicId: randomUUID(), goal: 'x y z', weeklyHours: 3 }).expect(404);
    const bad = await start(cookie, { topicId, goal: 'no', weeklyHours: 0, selfReport: { years: 3, extra: 1 }, admin: true }).expect(400);
    const fields = ((bad.body as { errors: { field: string }[] }).errors).map((e) => e.field).sort();
    expect(fields).toEqual(expect.arrayContaining(['admin', 'goal', 'selfReport.extra', 'weeklyHours']));
    await http().post('/v1/diagnostics').set('Cookie', cookie).send({ topicId, goal: 'csrf', weeklyHours: 3 }).expect(403);
    await http().post('/v1/diagnostics').set(csrf).send({ topicId, goal: 'anon', weeklyHours: 3 }).expect(401);
  });
});
