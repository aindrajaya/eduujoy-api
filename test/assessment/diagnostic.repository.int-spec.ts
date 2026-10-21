import { randomUUID } from 'node:crypto';
import { Logger } from '@nestjs/common';
import { eq } from 'drizzle-orm';
import { type Client } from 'pg';
import { DrizzleDiagnosticRepository } from '../../src/modules/assessment/infrastructure/drizzle-diagnostic.repository';
import { diagnosticItems } from '../../src/shared/db/schema/assessment';
import { topics } from '../../src/shared/db/schema/catalog';
import { users } from '../../src/shared/db/schema/identity';
import { loadSeed } from '../../src/shared/db/seed/load-seed';
import { parseSeed } from '../../src/shared/db/seed/seed-data';
import { connectTestClient, testDb, type TestDb } from '../db/connect';
import { fixtureBank, fixtureBankSeed } from '../fixtures/diagnostic/bank';

jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);

describe('DrizzleDiagnosticRepository (integration)', () => {
  let client: Client;
  let db: TestDb;
  let repo: DrizzleDiagnosticRepository;
  let topicId: string;
  let userId: string;

  beforeAll(async () => {
    client = await connectTestClient();
    db = testDb(client);
    repo = new DrizzleDiagnosticRepository(db);
    const slug = `diag-repo-${randomUUID().slice(0, 8)}`;
    await loadSeed(db, parseSeed(fixtureBankSeed(slug, 'Diagnostic repo topic')));
    const [topic] = await db.select().from(topics).where(eq(topics.slug, slug));
    topicId = topic?.id ?? '';
    // Items the bank must never serve: a short answer and a malformed choice item.
    await db.insert(diagnosticItems).values([
      { topicId, stage: 'novice', bloom: 'C1', kind: 'short_answer', body: { prompt: 'Explain', answerKey: { text: 'x' } } },
      { topicId, stage: 'novice', bloom: 'C1', kind: 'single_choice', body: { prompt: 'No options' } },
    ]);
    const [user] = await db.insert(users).values({ email: `diag-repo-${randomUUID()}@example.com` }).returning();
    userId = user?.id ?? '';
  });

  afterAll(async () => {
    await client.end();
  });

  it('serves only gradable, well-formed items, mapped to ladder cells', async () => {
    const bank = await repo.loadBank(topicId);

    expect(bank).toHaveLength(fixtureBank().length);
    expect(bank.every((s) => s.item.kind !== ('short_answer' as string))).toBe(true);
    const scenario = bank.find((s) => s.item.kind === 'scenario');
    expect(scenario).toMatchObject({ item: { cell: 2, answerKey: ['b'] }, bloom: 'C2', options: [{ id: 'a' }, { id: 'b' }, { id: 'c' }] });
  });

  it('creates, locks, updates and completes a session with its placement', async () => {
    const state = { engine: { estimate: 4, current: ['x'], served: ['x'], results: [], estimates: [] }, progress: { answered: 0, estimatedTotal: 8 } };
    const created = await db.transaction((tx) =>
      repo.create(tx, { userId, topicId, goal: 'g', weeklyHours: 3, preferredFormats: ['video'], selfReport: { years: 3 }, state, completed: false }),
    );
    expect(created).toMatchObject({ status: 'in_progress', state });

    // The partial unique index blocks a second open session for the same user and topic.
    await expect(
      db.transaction((tx) => repo.create(tx, { userId, topicId, goal: 'g', weeklyHours: 3, preferredFormats: [], selfReport: null, state, completed: false })),
    ).resolves.toBeNull();
    await expect(repo.findOpen(userId, topicId)).resolves.toMatchObject({ id: created?.id });

    const id = created?.id ?? '';
    const [item] = await repo.loadBank(topicId);
    const done = { ...state, progress: { answered: 1, estimatedTotal: 1 } };
    await db.transaction(async (tx) => {
      expect(await repo.lock(tx, id)).toMatchObject({ id });
      await repo.saveAnswers(tx, id, [{ itemId: item?.item.id ?? '', answer: { optionIds: ['b'] }, skipped: false, score: 100 }]);
      await repo.update(tx, id, done, true);
      await repo.createPlacement(tx, {
        sessionId: id,
        userId,
        topicId,
        placement: { cell: 5, position: { stage: 'competent', bloom: 'C4' }, confidence: 0.87, reason: 'r' },
        basis: 'items',
      });
    });

    expect(await repo.findById(id)).toMatchObject({ status: 'completed', state: done, completedAt: expect.any(Date) as Date });
    expect(await repo.findPlacement(id)).toMatchObject({ placement: { cell: 5, position: { stage: 'competent', bloom: 'C4' }, confidence: 0.87 } });
    await expect(repo.findOpen(userId, topicId)).resolves.toBeNull();
  });
});
