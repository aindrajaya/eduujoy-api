import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { type Client } from 'pg';
import { type NewStep } from '../../src/modules/pathing/application/ports/path.repository';
import { DrizzlePathRepository } from '../../src/modules/pathing/infrastructure/drizzle-path.repository';
import { paths, pathSteps } from '../../src/shared/db/schema/pathing';
import { connectTestClient, testDb, type TestDb } from '../db/connect';
import { learner, placement, topic } from './fixtures';

const step = (n: number): NewStep => ({
  n,
  objective: `Objective ${n}`,
  bloom: n < 4 ? 'C3' : 'C4',
  actions: [
    { n: 1, text: 'Read', done: false },
    { n: 2, text: 'Practise', done: false },
  ],
  resourceIds: [randomUUID()],
  checkpoint: { items: [{ id: 'i1', kind: 'single_choice', prompt: 'Which?', options: [{ id: 'a', label: 'A' }, { id: 'b', label: 'B' }] }], rubric: ['clear'], passScore: 80 },
  answerKeys: [{ correctOptionIds: ['b'], expectedAnswer: null }],
  doneWhen: 'Done',
  estMinutes: 30,
});

describe('DrizzlePathRepository (integration, A9)', () => {
  let client: Client;
  let db: TestDb;
  let repo: DrizzlePathRepository;

  beforeAll(async () => {
    client = await connectTestClient();
    db = testDb(client);
    repo = new DrizzlePathRepository(db);
  });

  afterAll(async () => {
    await client.end();
  });

  async function newPath(): Promise<{ userId: string; topicId: string; placementId: string; pathId: string }> {
    const userId = await learner(db);
    const topicId = await topic(db);
    const placementId = await placement(db, userId, topicId);
    const pathId = await db.transaction((tx) =>
      repo.create(tx, { userId, topicId, placementId, from: { stage: 'advanced_beginner', bloom: 'C3' }, to: { stage: 'competent', bloom: 'C4' }, goal: 'g', weeklyHours: 4 }),
    );
    if (!pathId) throw new Error('not created');
    return { userId, topicId, placementId, pathId };
  }

  it('allows one live path per placement, and another once that one failed', async () => {
    const { userId, topicId, placementId, pathId } = await newPath();
    const again = () =>
      db.transaction((tx) => repo.create(tx, { userId, topicId, placementId, from: { stage: 'advanced_beginner', bloom: 'C3' }, to: { stage: 'competent', bloom: 'C4' }, goal: null, weeklyHours: 4 }));

    await expect(again()).resolves.toBeNull();
    expect((await repo.findLiveForPlacement(userId, placementId))?.id).toBe(pathId);
    await db.transaction((tx) => repo.setStatus(tx, pathId, 'generating', 'failed'));
    expect(await repo.findLiveForPlacement(userId, placementId)).toBeNull();
    await expect(again()).resolves.toEqual(expect.any(String));
  });

  it('stores one replay per user and key', async () => {
    const { userId, pathId } = await newPath();
    const replay = { pathId, requestHash: 'h1', response: { jobId: randomUUID(), status: 'queued', eventsUrl: '/v1/jobs/x/events' } };

    await expect(db.transaction((tx) => repo.saveReplay(tx, { ...replay, userId, idempotencyKey: 'key-12345' }))).resolves.toBe(true);
    await expect(db.transaction((tx) => repo.saveReplay(tx, { ...replay, requestHash: 'h2', userId, idempotencyKey: 'key-12345' }))).resolves.toBe(false);
    await expect(repo.findReplay(userId, 'key-12345')).resolves.toEqual(replay);
    await expect(repo.findReplay(await learner(db), 'key-12345')).resolves.toBeNull();
    await expect(repo.countCreatedSince(userId, new Date(Date.now() - 60_000))).resolves.toBe(1);
  });

  it('activates once with step 1 active, never returns answer keys, and summarises', async () => {
    const { userId, pathId } = await newPath();
    const steps = [1, 2, 3, 4, 5, 6].map(step);

    await expect(db.transaction((tx) => repo.activate(tx, pathId, steps, { model: 'claude-sonnet-5-5', promptVersion: 'v1' }))).resolves.toBe(true);
    await expect(db.transaction((tx) => repo.activate(tx, pathId, steps, { model: 'm', promptVersion: 'v1' }))).resolves.toBe(false);

    const stored = await repo.steps(pathId);
    expect(stored.map((s) => s.status)).toEqual(['active', 'locked', 'locked', 'locked', 'locked', 'locked']);
    expect(JSON.stringify(stored)).not.toContain('correctOptionIds');
    const [raw] = await db.select({ keys: pathSteps.answerKeys }).from(pathSteps).where(eq(pathSteps.id, stored[0]?.id ?? ''));
    expect(raw?.keys).toEqual([{ correctOptionIds: ['b'], expectedAnswer: null }]);

    const summary = await repo.summary(userId, pathId);
    expect(summary).toMatchObject({ status: 'active', stepsDone: 0, stepsTotal: 6, totalMinutes: 180, currentStep: { n: 1, status: 'active' } });
    expect(await repo.summary(await learner(db), pathId)).toBeNull();
  });

  it('marks actions, unlocks the next step on completion, and completes the path after the last', async () => {
    const { userId, pathId } = await newPath();
    await db.transaction((tx) => repo.activate(tx, pathId, [1, 2, 3, 4, 5, 6].map(step), { model: 'm', promptVersion: 'v1' }));
    const [first, second] = await repo.steps(pathId);

    // Only the active step changes status; actions and difficulty work on any step.
    await expect(repo.patchStep(userId, second?.id ?? '', { status: 'completed' })).resolves.toEqual({ kind: 'not_active' });
    await expect(repo.patchStep(await learner(db), first?.id ?? '', { difficulty: 'ok' })).resolves.toEqual({ kind: 'not_found' });
    const marked = await repo.patchStep(userId, first?.id ?? '', { actionsDone: [{ n: 2, done: true }], difficulty: 'too_easy' });
    expect(marked).toMatchObject({ kind: 'ok', step: { actions: [{ n: 1, done: false }, { n: 2, done: true }], difficulty: 'too_easy', status: 'active' }, unlocked: null });

    const done = await repo.patchStep(userId, first?.id ?? '', { status: 'completed' });
    expect(done).toMatchObject({ kind: 'ok', step: { status: 'completed' }, unlocked: { n: 2, status: 'active' }, pathCompleted: false });
    for (const s of (await repo.steps(pathId)).slice(1)) {
      const out = await repo.patchStep(userId, s.id, { status: s.n === 4 ? 'skipped' : 'completed' });
      expect(out).toMatchObject({ kind: 'ok', pathCompleted: s.n === 6 });
    }
    expect(await repo.summary(userId, pathId)).toMatchObject({ status: 'completed', stepsDone: 6, currentStep: null });
  });

  it('marks a refund once and finds paths in review past the deadline', async () => {
    const { pathId } = await newPath();
    await db.transaction((tx) => repo.setStatus(tx, pathId, 'generating', 'under_review'));
    await db.update(paths).set({ updatedAt: new Date(Date.now() - 49 * 3600_000) }).where(eq(paths.id, pathId));
    const cutoff = new Date(Date.now() - 48 * 3600_000);

    expect((await repo.reviewOverdue(cutoff, 500)).map((p) => p.id)).toContain(pathId);
    await expect(db.transaction((tx) => repo.markRefunded(tx, pathId))).resolves.toBe(true);
    await expect(db.transaction((tx) => repo.markRefunded(tx, pathId))).resolves.toBe(false);
    expect((await repo.reviewOverdue(cutoff, 500)).map((p) => p.id)).not.toContain(pathId);
  });

  it('lists newest first with a cursor and filters', async () => {
    const { userId, topicId } = await newPath();
    const second = await placement(db, userId, topicId);
    await db.transaction((tx) => repo.create(tx, { userId, topicId, placementId: second, from: { stage: 'advanced_beginner', bloom: 'C3' }, to: { stage: 'competent', bloom: 'C4' }, goal: null, weeklyHours: 2 }));

    const all = await repo.list(userId, { limit: 10 });
    expect(all).toHaveLength(2);
    expect((all[0]?.createdAt.getTime() ?? 0) >= (all[1]?.createdAt.getTime() ?? 0)).toBe(true);
    const page = await repo.list(userId, { limit: 1 });
    const rest = await repo.list(userId, { limit: 10, before: { createdAt: page[0]?.createdAt ?? new Date(), id: page[0]?.id ?? '' } });
    expect(rest.map((p) => p.id)).toEqual([all[1]?.id]);
    expect(await repo.list(userId, { limit: 10, status: 'active' })).toEqual([]);
    expect(await repo.list(userId, { limit: 10, topicId: await topic(db) })).toEqual([]);
  });
});
