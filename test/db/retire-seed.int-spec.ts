import { randomUUID } from 'node:crypto';
import { eq, inArray, isNotNull } from 'drizzle-orm';
import { type Client } from 'pg';
import { retirementCap, retireSeedItems } from '../../src/shared/db/seed/retire-seed';
import { diagnosticAnswers, diagnosticItems, diagnosticSessions } from '../../src/shared/db/schema/assessment';
import { topics } from '../../src/shared/db/schema/catalog';
import { users } from '../../src/shared/db/schema/identity';
import { connectTestClient, testDb, type TestDb } from './connect';

const body = { prompt: 'Which?', options: [{ id: 'a', label: 'A' }, { id: 'b', label: 'B' }], answerKey: { optionIds: ['a'] } };

describe('retireSeedItems (integration, lead gate 2 Nov 2026)', () => {
  let client: Client;
  let db: TestDb;

  beforeAll(async () => {
    client = await connectTestClient();
    db = testDb(client);
    // Enough seed-topic items that the cap (1%, at most 200) allows the few removals these tests make.
    const filler = await topic('seed');
    await db.insert(diagnosticItems).values(
      Array.from({ length: 250 }, (_, i) => ({ topicId: filler.id, seedKey: `${filler.slug}:f${i}`, stage: 'novice' as const, bloom: 'C1' as const, kind: 'single_choice' as const, body })),
    );
  });

  afterAll(async () => {
    await client.end();
  });

  async function topic(origin: 'seed' | 'learner'): Promise<{ id: string; slug: string }> {
    const slug = `retire-${origin}-${randomUUID().slice(0, 8)}`;
    const [row] = await db.insert(topics).values({ slug, canonicalName: slug, domain: 'software', origin }).returning({ id: topics.id, slug: topics.slug });
    if (!row) throw new Error('no topic');
    return row;
  }

  async function item(topicId: string, seedKey: string | null): Promise<string> {
    const [row] = await db.insert(diagnosticItems).values({ topicId, seedKey, stage: 'novice', bloom: 'C1', kind: 'single_choice', body }).returning({ id: diagnosticItems.id });
    return row?.id ?? '';
  }

  /** The seed keys "in the files": every seed key in the schema except `gone` (other suites share it). */
  async function fileKeysWithout(gone: string[]): Promise<string[]> {
    const rows = await db.select({ key: diagnosticItems.seedKey }).from(diagnosticItems).where(isNotNull(diagnosticItems.seedKey));
    return rows.map((r) => r.key ?? '').filter((k) => !gone.includes(k));
  }

  async function exists(ids: string[]): Promise<string[]> {
    return (await db.select({ id: diagnosticItems.id }).from(diagnosticItems).where(inArray(diagnosticItems.id, ids))).map((r) => r.id);
  }

  it('deletes unreferenced removed seed items only, never learner-topic items, and a dry run deletes nothing', async () => {
    const seed = await topic('seed');
    const learner = await topic('learner');
    const keep = await item(seed.id, `${seed.slug}:keep`);
    const gone = await item(seed.id, `${seed.slug}:gone`);
    const learnerItem = await item(learner.id, `${learner.slug}:gone`);
    const keys = await fileKeysWithout([`${seed.slug}:gone`, `${learner.slug}:gone`]);

    const dry = await retireSeedItems(db, keys, { apply: false });
    expect(dry).toMatchObject({ outcome: 'dry_run', deleted: 0, referenced: [] });
    expect(dry.candidates.map((c) => c.seedKey)).toEqual([`${seed.slug}:gone`]);
    expect(await exists([keep, gone, learnerItem])).toHaveLength(3);

    const applied = await retireSeedItems(db, keys, { apply: true, expectRemoved: 1 });
    expect(applied).toMatchObject({ outcome: 'deleted', deleted: 1 });
    expect((await exists([keep, gone, learnerItem])).sort()).toEqual([keep, learnerItem].sort());
    // Idempotent: a second run finds nothing.
    expect(await retireSeedItems(db, keys, { apply: true, expectRemoved: 1 })).toMatchObject({ outcome: 'nothing_to_do', candidates: [] });
  });

  it('refuses, deleting nothing, when a removed item is held in a session state without a foreign key', async () => {
    const seed = await topic('seed');
    const held = await item(seed.id, `${seed.slug}:held`);
    const free = await item(seed.id, `${seed.slug}:free`);
    const [user] = await db.insert(users).values({ email: `retire-${randomUUID()}@example.com` }).returning({ id: users.id });
    await db.insert(diagnosticSessions).values({
      userId: user?.id ?? '',
      topicId: seed.id,
      goal: 'g',
      weeklyHours: 2,
      state: { engine: { estimate: 0, current: [held], served: [held], results: [], estimates: [] }, progress: { answered: 0, estimatedTotal: 8 } },
    });
    const keys = await fileKeysWithout([`${seed.slug}:held`, `${seed.slug}:free`]);

    const result = await retireSeedItems(db, keys, { apply: true, expectRemoved: 2 });
    expect(result.outcome).toBe('refused_referenced');
    expect(result.deleted).toBe(0);
    expect(result.referenced.map((c) => c.seedKey)).toEqual([`${seed.slug}:held`]);
    expect(result.referenced[0]?.heldBy).toEqual({ 'diagnostic_sessions.state': 1 });
    expect(await exists([held, free])).toHaveLength(2);
  });

  it('refuses when a removed item has an answer (the foreign key)', async () => {
    const seed = await topic('seed');
    const answered = await item(seed.id, `${seed.slug}:answered`);
    const [user] = await db.insert(users).values({ email: `retire-${randomUUID()}@example.com` }).returning({ id: users.id });
    const [session] = await db.insert(diagnosticSessions).values({ userId: user?.id ?? '', topicId: seed.id, goal: 'g', weeklyHours: 2 }).returning({ id: diagnosticSessions.id });
    await db.insert(diagnosticAnswers).values({ sessionId: session?.id ?? '', itemId: answered, answer: { optionIds: ['a'] }, score: 100 });
    // The session's own state names nothing; only the answer row references the item.
    await db.update(diagnosticSessions).set({ state: {} }).where(eq(diagnosticSessions.id, session?.id ?? ''));

    const result = await retireSeedItems(db, await fileKeysWithout([`${seed.slug}:answered`]), { apply: true, expectRemoved: 1 });
    expect(result).toMatchObject({ outcome: 'refused_referenced', deleted: 0 });
    expect(result.referenced[0]).toMatchObject({ seedKey: `${seed.slug}:answered`, answers: 1 });
    expect(await exists([answered])).toEqual([answered]);
  });

  it('refuses an apply without the exact expected count, deleting nothing', async () => {
    const seed = await topic('seed');
    const gone = await item(seed.id, `${seed.slug}:gone`);
    const keys = await fileKeysWithout([`${seed.slug}:gone`]);

    expect(await retireSeedItems(db, keys, { apply: true })).toMatchObject({ outcome: 'refused_expect_missing', deleted: 0 });
    expect(await retireSeedItems(db, keys, { apply: true, expectRemoved: 2 })).toMatchObject({ outcome: 'refused_count_mismatch', deleted: 0 });
    expect(await exists([gone])).toEqual([gone]);
    expect(await retireSeedItems(db, keys, { apply: true, expectRemoved: 1 })).toMatchObject({ outcome: 'deleted', deleted: 1 });
  });

  it('refuses a near-empty seed directory, and more candidates than the cap, even in a dry run', async () => {
    const before = (await db.select({ id: diagnosticItems.id }).from(diagnosticItems)).length;
    // An empty --dir: every seed item would be a candidate.
    const empty = await retireSeedItems(db, [], { apply: true, expectRemoved: 0 });
    expect(empty.outcome).toBe('refused_files_short');

    // The files hold as many items as the database, but cap + 1 of them are new keys: over the cap.
    // Only seed-topic keys are swapped (learner-topic items are never candidates).
    const all = await fileKeysWithout([]);
    const seedTopic = (await db.select({ key: diagnosticItems.seedKey }).from(diagnosticItems).innerJoin(topics, eq(topics.id, diagnosticItems.topicId)).where(eq(topics.origin, 'seed')))
      .map((r) => r.key ?? '')
      .filter(Boolean);
    const keys = [...seedTopic, ...all.filter((k) => !seedTopic.includes(k))];
    const cap = retirementCap(empty.limits.seedTopicItems);
    const dropped = keys.slice(0, cap + 1);
    const swapped = [...keys.slice(cap + 1), ...dropped.map((k) => `${k}-renamed`)];
    const over = await retireSeedItems(db, swapped, { apply: false });
    expect(over).toMatchObject({ outcome: 'refused_over_cap', deleted: 0 });
    expect(over.candidates).toHaveLength(cap + 1);
    expect((await db.select({ id: diagnosticItems.id }).from(diagnosticItems)).length).toBe(before);
  });
});

