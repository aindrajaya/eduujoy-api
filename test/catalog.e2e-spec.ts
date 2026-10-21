import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { eq, inArray } from 'drizzle-orm';
import request from 'supertest';
import { TOPIC_NORMALIZER, type TopicNormalizer } from '../src/modules/catalog/application/ports/topic-normalizer';
import { fallbackTopicName, topicDocument } from '../src/modules/catalog/domain/resolution';
import { EMBEDDER } from '../src/shared/ai';
import { AccessTokenService } from '../src/shared/common/auth';
import { DATABASE, type Database } from '../src/shared/db';
import { topics } from '../src/shared/db/schema/catalog';
import { users } from '../src/shared/db/schema/identity';
import { loadSeed } from '../src/shared/db/seed/load-seed';
import { parseSeed, readSeedFiles } from '../src/shared/db/seed/seed-data';
import { createTestApp, type TestApp } from './app';
import { decodeVector, loadGoldenEmbeddings, RecordedEmbedder } from './fixtures/catalog/embeddings';
import golden from './fixtures/catalog/golden.json';

const csrf = { Origin: 'http://localhost:5173', 'X-Requested-With': 'eduujoy' };
const TOPIC_FIELDS = ['aliases', 'canonicalName', 'description', 'id', 'parentId'];

interface GoldenCase {
  text: string;
  expect: 'topic' | 'choices' | 'new';
  slugs?: string[];
}

interface ResolveBody {
  status: 'matched' | 'choices' | 'created';
  topic?: { id: string; canonicalName: string };
  choices?: { id: string; similarity: number }[];
}

const recording = loadGoldenEmbeddings();

/** Normaliser stand-in: the learner's words as the name, so created topics stay distinct. */
const normalizer: TopicNormalizer = {
  normalise: (text) => Promise.resolve({ canonicalName: fallbackTopicName(text), domain: 'non_technical', description: 'A learner topic.', aliases: [] }),
};

describe('catalog (e2e, PRD-API §13 A6 Verify)', () => {
  let app: TestApp;
  let db: Database;
  let embedder: RecordedEmbedder | null;
  const slugById = new Map<string, string>();

  beforeAll(async () => {
    embedder = recording ? new RecordedEmbedder(recording) : null;
    app = await createTestApp((builder) =>
      builder
        .overrideProvider(EMBEDDER)
        .useValue(embedder ?? { embed: () => Promise.reject(new Error('no recording')) })
        .overrideProvider(TOPIC_NORMALIZER)
        .useValue(normalizer),
    );
    db = app.get<Database>(DATABASE);
    const seed = parseSeed(readSeedFiles(join(__dirname, '..', 'seed')));
    await loadSeed(db, seed);
    const rows = await db.select({ id: topics.id, slug: topics.slug }).from(topics).where(inArray(topics.slug, seed.topics.map((t) => t.slug)));
    for (const r of rows) slugById.set(r.id, r.slug);
  });

  afterAll(async () => {
    await app.close();
  });

  const http = () => request(app.getHttpServer());

  async function signedInUser(): Promise<{ userId: string; cookie: string }> {
    const [user] = await db.insert(users).values({ email: `catalog-${randomUUID()}@example.com` }).returning();
    const userId = user?.id ?? '';
    const token = await app.get(AccessTokenService).sign({ userId, sessionId: randomUUID(), roles: ['learner'], plan: 'free' });
    return { userId, cookie: `ej_at=${token}` };
  }

  let ip = 0;
  // The throttle is per client IP (30/min); each call comes from its own address so the golden run isn't throttled.
  const resolve = (cookie: string, body: unknown) =>
    http()
      .post('/v1/topics/resolve')
      .set(csrf)
      .set('Cookie', cookie)
      .set('X-Forwarded-For', `10.6.${Math.floor(++ip / 250)}.${ip % 250}`)
      .send(body as object);

  // Runs before the golden test, which creates the topics for the 'new' phrases.
  it(`answers 429 with Retry-After once a learner has created today's 10 topics`, async () => {
    const { userId, cookie } = await signedInUser();
    await db.insert(topics).values(Array.from({ length: 10 }, (_, i) => ({ slug: `cap-${userId}-${i}`, canonicalName: `Cap ${i} ${userId}`, origin: 'learner' as const, createdBy: userId })));
    const text = recording ? (golden.cases as GoldenCase[]).find((c) => c.expect === 'new')?.text : undefined;
    if (!text) throw new Error('test/fixtures/catalog/embeddings.json is missing: the user runs `pnpm catalog:record-golden` once');

    const res = await resolve(cookie, { text }).expect(429);

    expect((res.body as { code: string }).code).toBe('RATE_LIMITED');
    expect(Number(res.headers['retry-after'])).toBeGreaterThan(0);
    // Existing topics still resolve for that learner.
    await resolve(cookie, { text: 'Kubernetes' }).expect(200);
    const mine = await db.select().from(topics).where(eq(topics.createdBy, userId));
    expect(mine).toHaveLength(10);
  });

  it('resolves the golden topic phrases correctly at least 95% of the time', async () => {
    if (!recording || !embedder) {
      throw new Error('test/fixtures/catalog/embeddings.json is missing: the user runs `pnpm catalog:record-golden` once');
    }
    // Seed topics get their recorded document vectors, keyed by the same topicDocument() text the API embeds.
    // (EmbedTopics itself is covered by unit and integration tests; here other specs' topics would block it.)
    const seed = parseSeed(readSeedFiles(join(__dirname, '..', 'seed')));
    const vectors = new Map(recording.documents.map((d) => [`${d.title}\u0000${d.text}`, decodeVector(d.vector)] as const));
    for (const t of seed.topics) {
      const doc = topicDocument(t);
      const vector = vectors.get(`${doc.title}\u0000${doc.text}`);
      if (!vector) throw new Error(`No recorded embedding for topic ${t.slug}; re-run pnpm catalog:record-golden`);
      await db.update(topics).set({ embedding: vector, embeddingModel: recording.model, embeddingVersion: recording.version }).where(eq(topics.slug, t.slug));
    }

    const results: { text: string; expect: string; got: string; ok: boolean }[] = [];
    for (const c of golden.cases as GoldenCase[]) {
      const { cookie } = await signedInUser();
      const res = await resolve(cookie, { text: c.text }).expect(200);
      const body = res.body as ResolveBody;
      const matched = body.topic ? slugById.get(body.topic.id) : undefined;
      const offered = (body.choices ?? []).map((ch) => slugById.get(ch.id) ?? '?');
      const ok =
        c.expect === 'new'
          ? body.status === 'created'
          : c.expect === 'topic'
            ? (body.status === 'matched' && matched === c.slugs?.[0]) || (body.status === 'choices' && offered.includes(c.slugs?.[0] ?? ''))
            : (body.status === 'choices' && offered.some((s) => c.slugs?.includes(s))) || (body.status === 'matched' && c.slugs?.includes(matched ?? '') === true);
      const got = body.status === 'choices' ? `choices ${offered.join(', ')}` : `${body.status} ${matched ?? body.topic?.canonicalName ?? ''}`;
      results.push({ text: c.text, expect: `${c.expect} ${c.slugs?.join('|') ?? ''}`.trim(), got, ok });
    }

    const failures = results.filter((r) => !r.ok);
    const accuracy = (results.length - failures.length) / results.length;
    const strict = results.filter((r, i) => (golden.cases[i] as GoldenCase).expect === 'topic' && r.got.startsWith('matched ') && r.ok).length;
    process.stdout.write(
      `Golden set: ${results.length - failures.length}/${results.length} correct (${(accuracy * 100).toFixed(1)}%), ` +
        `${strict} auto-matched.\n${failures.map((f) => `  MISS "${f.text}": expected ${f.expect}, got ${f.got}`).join('\n')}\n`,
    );
    // Every golden query was recorded; only created topics' document embeddings miss (left for the backfill).
    expect(embedder.misses.filter((m) => m.startsWith('query:'))).toEqual([]);
    expect(accuracy).toBeGreaterThanOrEqual(0.95);
    // 150 vector writes and ~100 resolves, each a round trip to the Neon test branch.
  }, 180_000);

  it('matches an exact name without an embedding call and returns only contract fields', async () => {
    const { cookie } = await signedInUser();

    const res = await resolve(cookie, { text: '  REACT hooks ' }).expect(200);

    const body = res.body as ResolveBody & { topic: Record<string, unknown> };
    expect(body.status).toBe('matched');
    expect(body.topic).toMatchObject({ canonicalName: 'React hooks', parentId: expect.any(String) as unknown });
    expect(Object.keys(body.topic).sort()).toEqual(TOPIC_FIELDS);
    expect(Object.keys(body).sort()).toEqual(['status', 'topic']);
  });

  it('validates input and enforces CSRF and auth', async () => {
    const { cookie } = await signedInUser();

    for (const body of [{ text: 'a' }, { text: 'x'.repeat(121) }, { text: 'react', extra: true }, {}, { text: 42 }]) {
      const res = await resolve(cookie, body).expect(400);
      expect((res.body as { code: string }).code).toBe('VALIDATION_FAILED');
    }
    const punctuation = await resolve(cookie, { text: '?!?' }).expect(400);
    expect((punctuation.body as { errors: { field: string }[] }).errors[0]?.field).toBe('text');
    await http().post('/v1/topics/resolve').set('Cookie', cookie).send({ text: 'react' }).expect(403);
    await http().post('/v1/topics/resolve').set(csrf).send({ text: 'react' }).expect(401);
  });
});
