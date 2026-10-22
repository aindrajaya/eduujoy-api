import { readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { eq } from 'drizzle-orm';
import request from 'supertest';
import { cellIndex, LADDER } from '../src/modules/assessment/domain/diagnostic';
import { AccessTokenService } from '../src/shared/common/auth';
import { DATABASE, type Database } from '../src/shared/db';
import { diagnosticItems } from '../src/shared/db/schema/assessment';
import { topics } from '../src/shared/db/schema/catalog';
import { users } from '../src/shared/db/schema/identity';
import { loadSeed } from '../src/shared/db/seed/load-seed';
import { parseSeed } from '../src/shared/db/seed/seed-data';
import { createTestApp, type TestApp } from './app';
import { secretKeyPaths } from './leaks';

const csrf = { Origin: 'http://localhost:5173', 'X-Requested-With': 'eduujoy' };
const SEED = join(__dirname, '..', 'seed');
// A real, non-fixture topic from the credit-sprint seed (tools/seed): its 70 generated items.
const TOPIC_SLUG = 'python';

interface BatchBody {
  diagnosticId: string;
  status: 'in_progress' | 'completed';
  progress: { answered: number };
  items?: { id: string; kind: string; options?: { id: string }[] }[];
  placement?: { position: { stage: string; bloom: string }; confidence: number };
}

describe('diagnostic on a seeded topic (e2e: the generated item banks drive the adaptive engine)', () => {
  let app: TestApp;
  let db: Database;
  let topicId: string;
  let keys: Map<string, { cell: number; answerKey: string[] }>;

  beforeAll(async () => {
    app = await createTestApp();
    db = app.get<Database>(DATABASE);
    // The full taxonomy plus one topic's real item bank (loading all 10,500 items would only slow the run).
    await loadSeed(
      db,
      parseSeed({
        topics: JSON.parse(readFileSync(join(SEED, 'topics.json'), 'utf8')) as unknown,
        items: { [TOPIC_SLUG]: JSON.parse(readFileSync(join(SEED, 'items', `${TOPIC_SLUG}.json`), 'utf8')) as unknown },
      }),
    );
    const [topic] = await db.select().from(topics).where(eq(topics.slug, TOPIC_SLUG));
    topicId = topic?.id ?? '';
    const rows = await db.select().from(diagnosticItems).where(eq(diagnosticItems.topicId, topicId));
    keys = new Map(rows.map((r) => [r.id, { cell: cellIndex(r.stage, r.bloom), answerKey: (r.body as { answerKey?: { optionIds?: string[] } }).answerKey?.optionIds ?? [] }]));
  }, 120_000);

  afterAll(async () => {
    await app.close();
  });

  async function learner(): Promise<string> {
    const [user] = await db.insert(users).values({ email: `seeded-${randomUUID()}@example.com` }).returning();
    return `ej_at=${await app.get(AccessTokenService).sign({ userId: user?.id ?? '', sessionId: randomUUID(), roles: ['learner'], plan: 'free' })}`;
  }

  it('loads the real bank: 70 gradable items over all 10 cells, scenarios included', () => {
    expect(keys.size).toBe(70);
    const cells = new Set([...keys.values()].map((k) => k.cell));
    expect(cells.size).toBe(LADDER.length);
    expect([...keys.values()].every((k) => k.answerKey.length > 0)).toBe(true);
  });

  async function play(knows: number, selfReport?: { years?: number; projectsShipped?: number }) {
    const cookie = await learner();
    const http = () => request(app.getHttpServer());
    let body = (
      await http()
        .post('/v1/diagnostics')
        .set(csrf)
        .set('Cookie', cookie)
        .send({ topicId, goal: 'Real bank', weeklyHours: 4, ...(selfReport ? { selfReport } : {}) })
        .expect(201)
    ).body as BatchBody;
    let served = 0;
    let scenarios = 0;
    while (body.status === 'in_progress') {
      expect(secretKeyPaths(body)).toEqual([]);
      const items = body.items ?? [];
      served += items.length;
      scenarios += items.filter((i) => i.kind === 'scenario').length;
      const answers = items.map((i) => {
        const key = keys.get(i.id);
        if (!key) throw new Error(`unknown item ${i.id}`);
        const wrong = (i.options ?? []).map((o) => o.id).find((id) => !key.answerKey.includes(id));
        return { itemId: i.id, optionIds: key.cell <= knows ? key.answerKey : wrong ? [wrong] : [] };
      });
      body = (await http().post(`/v1/diagnostics/${body.diagnosticId}/answers`).set(csrf).set('Cookie', cookie).send({ answers }).expect(200)).body as BatchBody;
    }
    const placed = body.placement?.position;
    const cell = placed ? cellIndex(placed.stage as never, placed.bloom as never) : -1;
    process.stdout.write(
      `seeded ${TOPIC_SLUG}: knows cell ${knows}, self-report ${JSON.stringify(selfReport ?? null)} → ${placed?.stage} ${placed?.bloom} (cell ${cell}) after ${served} items, ${scenarios} scenario(s), confidence ${body.placement?.confidence}\n`,
    );
    return { cell, served, scenarios };
  }

  // Learners report experience roughly in line with what they know (as the A7 fixture learners do).
  it.each([
    [1, undefined],
    [4, { projectsShipped: 3 }],
    [7, { years: 6 }],
    [9, { years: 12, projectsShipped: 25 }],
  ] as const)('places a learner who truly knows up to cell %i within one cell, in 8 to 12 items', async (knows, selfReport) => {
    const { cell, served, scenarios } = await play(knows, selfReport);

    expect(served).toBeGreaterThanOrEqual(8);
    expect(served).toBeLessThanOrEqual(12);
    expect(scenarios).toBeGreaterThanOrEqual(1);
    expect(Math.abs(cell - knows)).toBeLessThanOrEqual(1);
  }, 60_000);

  it('documents the A7 cap: an expert who skips the self-report is placed low (one-cell moves, 12 items)', async () => {
    const { cell } = await play(9);
    // Known and accepted in A7 (status: "silent-expert"); the first checkpoint's ±1-stage correction is the net.
    expect(cell).toBeLessThanOrEqual(4);
  }, 60_000);
});
