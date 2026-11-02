import { randomUUID } from 'node:crypto';
import { eq, inArray } from 'drizzle-orm';
import { type Client } from 'pg';
import { DrizzleDiagnosticRepository } from '../../src/modules/assessment/infrastructure/drizzle-diagnostic.repository';
import { loadSeed } from '../../src/shared/db/seed/load-seed';
import { SeedRetireRefusedError } from '../../src/shared/db/seed/retire-policy';
import { type SeedData, type SeedItem } from '../../src/shared/db/seed/seed-data';
import { diagnosticItems } from '../../src/shared/db/schema/assessment';
import { topics } from '../../src/shared/db/schema/catalog';
import { connectTestClient, testDb, type TestDb } from './connect';

/** One seed topic with `n` items (250 makes the cap 2: 1% of the active seed-topic items). */
function bank(slug: string, n = 250): SeedData {
  const items: SeedItem[] = Array.from({ length: n }, (_, i) => ({
    topic: slug,
    key: `q${i}`,
    seedKey: `${slug}:q${i}`,
    stage: 'novice',
    bloom: 'C1',
    kind: 'single_choice',
    prompt: `Question ${i}`,
    options: [
      { id: 'a', label: 'A' },
      { id: 'b', label: 'B' },
    ],
    answerKey: { optionIds: ['a'] },
    reviewed: true,
  }));
  return {
    topics: [{ slug, canonicalName: slug, aliases: [], description: 'Retire fixture.', domain: 'software', parent: null, prerequisites: [] }],
    items,
  };
}

describe('db:seed retires items that left the files (user decision, 2 Nov 2026)', () => {
  let client: Client;
  let db: TestDb;
  let repo: DrizzleDiagnosticRepository;

  beforeAll(async () => {
    client = await connectTestClient();
    db = testDb(client);
    repo = new DrizzleDiagnosticRepository(db);
  });

  afterAll(async () => {
    await client.end();
  });

  const rows = async (slug: string) =>
    db
      .select({ id: diagnosticItems.id, key: diagnosticItems.seedKey, retiredAt: diagnosticItems.retiredAt, prompt: diagnosticItems.body })
      .from(diagnosticItems)
      .innerJoin(topics, eq(topics.id, diagnosticItems.topicId))
      .where(eq(topics.slug, slug));
  const topicId = async (slug: string) => (await db.select({ id: topics.id }).from(topics).where(eq(topics.slug, slug)))[0]?.id ?? '';

  it('retires instead of deleting, keeps the rows, and never serves them to a new session', async () => {
    const slug = `retire-${randomUUID().slice(0, 8)}`;
    const full = bank(slug);
    await expect(loadSeed(db, full)).resolves.toMatchObject({ items: 250, retired: [], restored: 0 });

    const less = { ...full, items: full.items.filter((i) => i.key !== 'q3' && i.key !== 'q7') };
    await expect(loadSeed(db, less, { expectRetired: 2 })).resolves.toMatchObject({ retired: [`${slug}:q3`, `${slug}:q7`], restored: 0 });

    const after = await rows(slug);
    expect(after).toHaveLength(250);
    expect(after.filter((r) => r.retiredAt !== null).map((r) => r.key).sort()).toEqual([`${slug}:q3`, `${slug}:q7`]);
    const served = (await repo.loadBank(await topicId(slug))).map((s) => s.item.id);
    const retiredIds = after.filter((r) => r.retiredAt !== null).map((r) => r.id);
    expect(served).toHaveLength(248);
    expect(served).not.toEqual(expect.arrayContaining([retiredIds[0]]));
    // Idempotent: a re-run retires nothing more and needs no --expect-retired.
    await expect(loadSeed(db, less)).resolves.toMatchObject({ retired: [], restored: 0 });
  });

  it('lets a session that already holds a retired item keep it, and serves a returning item again', async () => {
    const slug = `retire-${randomUUID().slice(0, 8)}`;
    const full = bank(slug);
    await loadSeed(db, full);
    const [q5] = (await rows(slug)).filter((r) => r.key === `${slug}:q5`);
    await loadSeed(db, { ...full, items: full.items.filter((i) => i.key !== 'q5') }, { expectRetired: 1 });
    const id = await topicId(slug);

    // In flight: the session's served items are kept, so its answer still scores; new sessions don't see it.
    expect((await repo.loadBank(id, [q5?.id ?? ''])).map((s) => s.item.id)).toContain(q5?.id);
    expect((await repo.loadBank(id)).map((s) => s.item.id)).not.toContain(q5?.id);

    // Back in the files: active again, and served.
    await expect(loadSeed(db, full)).resolves.toMatchObject({ retired: [], restored: 1 });
    expect((await rows(slug)).find((r) => r.key === `${slug}:q5`)?.retiredAt).toBeNull();
    expect((await repo.loadBank(id)).map((s) => s.item.id)).toContain(q5?.id);
  });

  it('refuses without the exact count, over the cap, or from a short directory, and writes nothing at all', async () => {
    const slug = `retire-${randomUUID().slice(0, 8)}`;
    const full = bank(slug);
    await loadSeed(db, full);
    const edited = full.items.map((i) => (i.key === 'q0' ? { ...i, prompt: 'Edited in the refused run' } : i));
    const without = (keys: string[]) => ({ ...full, items: edited.filter((i) => !keys.includes(i.key)) });
    const refusal = async (data: SeedData, expectRetired?: number) =>
      loadSeed(db, data, expectRetired === undefined ? {} : { expectRetired }).then(
        () => null,
        (e: unknown) => (e instanceof SeedRetireRefusedError ? e.refusal : e),
      );

    expect(await refusal(without(['q1']))).toBe('expect_missing');
    expect(await refusal(without(['q1']), 2)).toBe('count_mismatch');
    // Over the cap needs files that are not short: three items leave, three new ones arrive (the count
    // stays 250). Dropping three alone trips files_short first (247 < 250 - cap 2).
    const renamed = edited.map((i) => (['q1', 'q2', 'q3'].includes(i.key) ? { ...i, key: `${i.key}-new`, seedKey: `${i.seedKey}-new` } : i));
    expect(await refusal({ ...full, items: renamed }, 3)).toBe('over_cap');
    expect(await refusal({ ...full, items: edited.slice(0, 100) }, 150)).toBe('files_short');
    // Every refusal rolled the whole seed back: nothing retired, and the edit in the same run is gone.
    const now = await rows(slug);
    expect(now.filter((r) => r.retiredAt !== null)).toEqual([]);
    expect(JSON.stringify(now.find((r) => r.key === `${slug}:q0`)?.prompt)).not.toContain('Edited in the refused run');
  });

  it('never touches learner-topic items or topics left out of the files', async () => {
    const slug = `retire-${randomUUID().slice(0, 8)}`;
    await loadSeed(db, bank(slug));
    const [learner] = await db.insert(topics).values({ slug: `learner-${randomUUID().slice(0, 8)}`, canonicalName: 'L', origin: 'learner' }).returning({ id: topics.id });
    await db.insert(diagnosticItems).values({ topicId: learner?.id ?? '', seedKey: `learner:${randomUUID()}`, stage: 'novice', bloom: 'C1', kind: 'single_choice', body: {} });

    // Loading another topic alone retires nothing in this one, nor the learner topic's item.
    await expect(loadSeed(db, bank(`retire-${randomUUID().slice(0, 8)}`))).resolves.toMatchObject({ retired: [] });
    expect((await rows(slug)).filter((r) => r.retiredAt !== null)).toEqual([]);
    const learnerItems = await db.select({ retiredAt: diagnosticItems.retiredAt }).from(diagnosticItems).where(inArray(diagnosticItems.topicId, [learner?.id ?? '']));
    expect(learnerItems.map((r) => r.retiredAt)).toEqual([null]);
  });

  it('never retires a topic whose items are absent from the files, even when the topic itself is listed', async () => {
    const a = bank(`retire-${randomUUID().slice(0, 8)}`);
    const b = bank(`retire-${randomUUID().slice(0, 8)}`, 30);
    await loadSeed(db, { topics: [...a.topics, ...b.topics], items: [...a.items, ...b.items] });
    // The e2e shape: the full taxonomy, one topic's bank. b's 30 items stay active and nothing is refused.
    await expect(loadSeed(db, { topics: [...a.topics, ...b.topics], items: a.items })).resolves.toMatchObject({ retired: [], restored: 0 });
    expect((await rows(b.topics[0]?.slug ?? '')).filter((r) => r.retiredAt !== null)).toEqual([]);
  });
});
