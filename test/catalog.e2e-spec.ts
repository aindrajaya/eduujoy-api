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
import { readFileSync } from 'node:fs';
import { decodeVector, loadGoldenEmbeddings, loadHoldoutEmbeddings, RecordedEmbedder } from './fixtures/catalog/embeddings';
import golden from './fixtures/catalog/golden.json';

const csrf = { Origin: 'http://localhost:5173', 'X-Requested-With': 'eduujoy' };
const TOPIC_FIELDS = ['aliases', 'canonicalName', 'description', 'id', 'parentId'];

interface GoldenCase {
  text: string;
  expect: 'topic' | 'choices' | 'new';
  slugs?: string[];
  exact?: boolean;
}

interface ResolveBody {
  status: 'matched' | 'choices' | 'created';
  topic?: { id: string; canonicalName: string };
  choices?: { id: string; similarity: number }[];
}

const golden_ = loadGoldenEmbeddings();
const holdoutRecording = loadHoldoutEmbeddings();
// The held-out queries ride on the same recorded embedder (their topic documents are the golden ones).
const recording = golden_ && holdoutRecording ? { ...golden_, queries: [...golden_.queries, ...holdoutRecording.queries] } : golden_;
const holdout = JSON.parse(readFileSync(join(__dirname, '..', 'seed', '_eval', 'topic-resolve-holdout.json'), 'utf8')) as {
  cases: (GoldenCase & { kind: string; nearSlugs?: string[] })[];
};

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

    const results: { case: GoldenCase; got: string; strict: boolean; lenient: boolean }[] = [];
    for (const c of golden.cases as GoldenCase[]) {
      const { cookie } = await signedInUser();
      const misses = embedder.misses.length;
      const res = await resolve(cookie, { text: c.text }).expect(200);
      const body = res.body as ResolveBody;
      const matched = body.topic ? slugById.get(body.topic.id) : undefined;
      const offered = (body.choices ?? []).map((ch) => slugById.get(ch.id) ?? '?');
      const inSet = (slug: string | undefined) => slug !== undefined && (c.slugs ?? []).includes(slug);
      let strict: boolean;
      let lenient: boolean;
      if (c.expect === 'new') {
        strict = lenient = body.status === 'created';
      } else if (c.expect === 'topic') {
        strict = body.status === 'matched' && matched === c.slugs?.[0];
        lenient = strict || (body.status === 'choices' && offered.includes(c.slugs?.[0] ?? ''));
      } else {
        strict = lenient = (body.status === 'choices' && offered.some(inSet)) || (body.status === 'matched' && inSet(matched));
      }
      if (c.exact) {
        // Exact names and unique aliases must match without touching the embedder.
        expect({ text: c.text, status: body.status, matched, embedded: embedder.misses.length !== misses }).toEqual({ text: c.text, status: 'matched', matched: c.slugs?.[0], embedded: false });
      }
      const got = body.status === 'choices' ? `choices ${offered.join(', ')}` : `${body.status} ${matched ?? body.topic?.canonicalName ?? ''}`;
      results.push({ case: c, got, strict, lenient });
    }

    const scored = results.filter((r) => !r.case.exact);
    const rate = (n: number) => `${n}/${scored.length} (${((n / scored.length) * 100).toFixed(1)}%)`;
    const strictN = scored.filter((r) => r.strict).length;
    const lenientN = scored.filter((r) => r.lenient).length;
    const topicCases = scored.filter((r) => r.case.expect === 'topic');
    const misses = scored.filter((r) => !r.lenient);
    const picks = scored.filter((r) => r.lenient && !r.strict);
    process.stdout.write(
      `Golden set (${scored.length} scored, ${results.length - scored.length} exact checked separately):\n` +
        `  lenient ${rate(lenientN)}  strict ${rate(strictN)}  auto-matched topic phrases ${topicCases.filter((r) => r.strict).length}/${topicCases.length}\n` +
        misses.map((r) => `  MISS "${r.case.text}": expected ${r.case.expect} ${r.case.slugs?.join('|') ?? ''}, got ${r.got}`).join('\n') +
        (misses.length ? '\n' : '') +
        picks.map((r) => `  PICK "${r.case.text}": learner chooses from ${r.got}`).join('\n') +
        '\n',
    );
    // Every golden query was recorded; only created topics' document embeddings miss (left for the backfill).
    expect(embedder.misses.filter((m) => m.startsWith('query:'))).toEqual([]);
    expect(lenientN / scored.length).toBeGreaterThanOrEqual(0.95);
    // 150 vector writes and ~100 resolves, each a round trip to the Neon test branch.
  }, 180_000);

  // Launch requirement (EXECUTION-PLAN §4): the held-out set was never used for tuning. It must reach
  // lenient >= 95% with no wrong auto-match. Runs after the golden test, which loads the topic vectors.
  (holdoutRecording ? it : it.skip)('held-out topic phrases: lenient >= 95% and no wrong auto-match (launch check)', async () => {
    const rows: { kind: string; text: string; got: string; strict: boolean; lenient: boolean; wrongMatch: boolean }[] = [];
    for (const c of holdout.cases) {
      const { cookie } = await signedInUser();
      const body = (await resolve(cookie, { text: c.text }).expect(200)).body as ResolveBody;
      const matched = body.topic ? slugById.get(body.topic.id) : undefined;
      const offered = (body.choices ?? []).map((ch) => slugById.get(ch.id) ?? '?');
      const inSet = (slug: string | undefined) => slug !== undefined && (c.slugs ?? []).includes(slug);
      let strict: boolean;
      let lenient: boolean;
      if (c.expect === 'new') {
        strict = lenient = body.status === 'created';
      } else if (c.expect === 'topic') {
        strict = body.status === 'matched' && matched === c.slugs?.[0];
        lenient = strict || (body.status === 'choices' && offered.includes(c.slugs?.[0] ?? ''));
      } else {
        strict = lenient = (body.status === 'choices' && offered.some(inSet)) || (body.status === 'matched' && inSet(matched));
      }
      // A wrong auto-match: matched a topic the case doesn't accept (for near-miss and new, any match).
      const wrongMatch = body.status === 'matched' && (c.expect === 'new' || !inSet(matched));
      const got = body.status === 'choices' ? `choices ${offered.join(', ')}` : `${body.status} ${matched ?? body.topic?.canonicalName ?? ''}`;
      rows.push({ kind: c.kind, text: c.text, got, strict, lenient, wrongMatch });
    }
    const pct = (n: number) => `${n}/${rows.length} (${((n / rows.length) * 100).toFixed(1)}%)`;
    const byKind = [...new Set(rows.map((r) => r.kind))].map((k) => {
      const of = rows.filter((r) => r.kind === k);
      return `${k} ${of.filter((r) => r.lenient).length}/${of.length}`;
    });
    process.stdout.write(
      `Held-out set: lenient ${pct(rows.filter((r) => r.lenient).length)}  strict ${pct(rows.filter((r) => r.strict).length)}  wrong auto-matches ${rows.filter((r) => r.wrongMatch).length}\n` +
        `  by kind: ${byKind.join(', ')}\n` +
        rows.filter((r) => !r.lenient || r.wrongMatch).map((r) => `  ${r.wrongMatch ? 'WRONG' : 'MISS'} [${r.kind}] "${r.text}": got ${r.got}`).join('\n') +
        '\n',
    );
    expect(rows.filter((r) => r.wrongMatch).map((r) => r.text)).toEqual([]);
    expect(rows.filter((r) => r.lenient).length / rows.length).toBeGreaterThanOrEqual(0.95);
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

  // Queries without a recorded vector fail like a Gemini outage, so they exercise the contract 0.4.0 fallback.
  it('falls back to name search during an embedding outage, and otherwise answers 503 with Retry-After', async () => {
    const { userId, cookie } = await signedInUser();
    const before = await db.select({ id: topics.id }).from(topics);

    const typo = await resolve(cookie, { text: 'kubernetis' }).expect(200);
    const body = typo.body as ResolveBody;
    expect(body.status).toBe('choices');
    expect(slugById.get(body.choices?.[0]?.id ?? '')).toBe('kubernetes');

    const none = await resolve(cookie, { text: 'zqxv wkpj' }).expect(503);
    expect((none.body as { code: string }).code).toBe('SERVICE_UNAVAILABLE');
    expect(none.headers['retry-after']).toBe('30');
    expect(await db.select({ id: topics.id }).from(topics)).toHaveLength(before.length);
    expect(await db.select().from(topics).where(eq(topics.createdBy, userId))).toEqual([]);
  });

  it('creates a topic with createNew when the learner rejects the choices (contract 0.5.0)', async () => {
    const { userId, cookie } = await signedInUser();
    // A recorded golden phrase that lands in the choices band.
    const offered = await resolve(cookie, { text: 'storing documents in mongodb' }).expect(200);
    expect((offered.body as ResolveBody).status).toBe('choices');

    const created = await resolve(cookie, { text: 'storing documents in mongodb', createNew: true }).expect(200);

    expect(created.body).toMatchObject({ status: 'created', topic: { canonicalName: 'Storing documents in mongodb' } });
    expect(await db.select().from(topics).where(eq(topics.createdBy, userId))).toHaveLength(1);
    await resolve(cookie, { text: 'storing documents in mongodb', createNew: 'yes' }).expect(400);
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
