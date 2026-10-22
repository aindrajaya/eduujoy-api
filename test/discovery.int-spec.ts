// A8 Verify (PRD-API §13): discovery end to end on the Neon test branch. Real handlers, repository,
// quota counter, review queue and unit of work; providers are in-memory fakes (no network, no spend).
import { createHash, randomUUID } from 'node:crypto';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { and, eq, inArray } from 'drizzle-orm';
import { type Client } from 'pg';
import { GetTopicProfileQuery } from '../src/modules/catalog/application/get-topic-profile.query';
import { DrizzleTopicRepository } from '../src/modules/catalog/infrastructure/drizzle-topic.repository';
import { AnalyseResource } from '../src/modules/discovery/application/analyse-resource.handler';
import { DiscoverResources } from '../src/modules/discovery/application/discover-resources.handler';
import { FakeLinkChecker, FakePaperSearch, FakeResourceAnalyzer, FakeVideoSearch, FakeWebDiscovery } from '../src/modules/discovery/application/discovery.fakes';
import { ANALYSE_RESOURCE_JOB, CHECK_LIVENESS_JOB } from '../src/modules/discovery/application/jobs';
import { CheckLiveness, LivenessSweep } from '../src/modules/discovery/application/liveness.handlers';
import { ClaudeWebDiscovery } from '../src/modules/discovery/infrastructure/claude-web-discovery';
import { GeminiResourceAnalyzer } from '../src/modules/discovery/infrastructure/gemini-resource-analyzer';
import { DrizzleDiscoveryRepository } from '../src/modules/discovery/infrastructure/drizzle-discovery.repository';
import { DrizzleQuotaCounter } from '../src/modules/discovery/infrastructure/drizzle-quota.counter';
import { type ResourceDead, type ResourcesReady, pacificDay, poolPlan, type Stage, YOUTUBE_SEARCH_GUARD, YOUTUBE_SEARCH_QUOTA } from '../src/modules/discovery/domain';
import { AiBudgetGuard, type BudgetScope, type Embedder, type EmbeddingRequest, PromptRegistry, type StructuredGenerator, type StructuredRequest, type WebSearcher } from '../src/shared/ai';
import { DrizzleLlmCallRecorder } from '../src/shared/ai/metering/llm-call.recorder';
import { MeteredEmbedder, MeteredStructuredGenerator, MeteredWebSearcher } from '../src/shared/ai/metering/metered';
import { ReviewQueue } from '../src/shared/common/review';
import { reviewItems } from '../src/shared/db/schema/admin';
import { llmCalls } from '../src/shared/db/schema/ai';
import { topics } from '../src/shared/db/schema/catalog';
import { discoveryResults, resourceCards, resources } from '../src/shared/db/schema/discovery';
import { EventBus } from '../src/shared/events/event-bus';
import { UnitOfWork } from '../src/shared/events/unit-of-work';
import { type EnqueueRequest, type JobContext, type JobQueue, JobRepository } from '../src/shared/jobs';
import { connectTestClient, testDb, type TestDb } from './db/connect';

const DIMS = 768;

/** A deterministic unit vector per text, so identical takeaways embed identically (the dedupe case). */
function vectorFor(text: string): number[] {
  const seed = createHash('sha256').update(text).digest();
  const v = Array.from({ length: DIMS }, (_, i) => ((seed[i % seed.length] ?? 0) - 127.5) * (i % 7 === 0 ? 1 : 0.01));
  const norm = Math.sqrt(v.reduce((s, x) => s + x * x, 0));
  return v.map((x) => x / norm);
}

class FakeEmbedder implements Embedder {
  readonly requests: EmbeddingRequest[] = [];
  embed(request: EmbeddingRequest) {
    this.requests.push(request);
    const call = { provider: 'google' as const, model: 'gemini-embedding-2', usage: { inputTokens: 1, cacheWriteTokens: 0, cacheReadTokens: 0, outputTokens: 0 }, latencyMs: 1 };
    return Promise.resolve({ vectors: request.texts.map(vectorFor), model: 'gemini-embedding-2', version: 1, call });
  }
}

const ctx = (jobId: string = randomUUID()): JobContext => ({
  jobId,
  attempt: 1,
  maxAttempts: 3,
  signal: new AbortController().signal,
  progress: () => Promise.resolve(),
  partial: () => Promise.resolve(),
});

describe('discovery (integration, A8 Verify)', () => {
  let client: Client;
  let db: TestDb;
  const tag = randomUUID().slice(0, 8);

  beforeAll(async () => {
    client = await connectTestClient();
    db = testDb(client);
  });

  afterAll(async () => {
    await client.end();
  });

  /** One wired pipeline; `day` isolates the quota counter between tests. */
  function pipeline(day: Date) {
    const repo = new DrizzleDiscoveryRepository(db);
    const videos = new FakeVideoSearch();
    const web = new FakeWebDiscovery();
    const papers = new FakePaperSearch();
    const links = new FakeLinkChecker(200);
    const analyzer = new FakeResourceAnalyzer();
    const embedder = new FakeEmbedder();
    const quota = new DrizzleQuotaCounter(db);
    const bus = new EventBus(new EventEmitter2());
    const ready: ResourcesReady[] = [];
    const dead: ResourceDead[] = [];
    bus.on<ResourcesReady>('ResourcesReady', (e) => ready.push(e));
    bus.on<ResourceDead>('ResourceDead', (e) => dead.push(e));
    const queued: EnqueueRequest[] = [];
    const queue = { enqueue: (r: EnqueueRequest) => (queued.push(r), Promise.resolve({ job: { id: randomUUID() }, created: true })) } as unknown as JobQueue;
    const budget = { assertCanStart: () => Promise.resolve(), status: () => Promise.resolve({ exceeded: false }) } as unknown as AiBudgetGuard;
    const topicsQuery = new GetTopicProfileQuery(new DrizzleTopicRepository(db));
    const uow = new UnitOfWork(db, bus);
    const clock = () => day;
    const discover = new DiscoverResources(repo, videos, web, papers, links, quota, clock, topicsQuery, budget, queue, uow);
    const analyse = new AnalyseResource(repo, analyzer, links, embedder, clock, topicsQuery, new ReviewQueue(), uow);

    /** Runs discovery, then every analyse job it queued, as the executor would. */
    async function run(topicId: string, stage: Stage, poolVersion = 1) {
      await discover.run(discover.parse({ topicId, stage, poolVersion }), ctx());
      const jobs = queued.filter((q) => q.type === ANALYSE_RESOURCE_JOB).splice(0);
      queued.length = 0;
      for (const job of jobs) await analyse.run(analyse.parse(job.payload), ctx());
      const [pool] = await db.select().from(discoveryResults).where(and(eq(discoveryResults.topicId, topicId), eq(discoveryResults.stage, stage)));
      return pool;
    }
    return { repo, videos, web, papers, links, analyzer, embedder, quota, ready, dead, queued, run, bus, clock };
  }

  async function topic(name: string, domain: 'software' | 'stem' | 'non_technical' = 'software'): Promise<string> {
    const [row] = await db
      .insert(topics)
      .values({ slug: `disc-${name.toLowerCase().replace(/\W+/g, '-')}-${tag}`, canonicalName: `${name} ${tag}`, domain })
      .returning({ id: topics.id, name: topics.canonicalName });
    if (!row) throw new Error('topic not created');
    return row.id;
  }

  /** Scripted providers for one topic: 2 videos, an article, an official doc, a dead link, a blocked one, a paper. */
  function script(p: ReturnType<typeof pipeline>, name: string, stage: Stage, slug: string) {
    const plan = poolPlan(name, stage);
    p.videos.add(plan.videoSearches[0] ?? '', { youtubeId: `${slug.slice(0, 4)}vid0001`, durationMin: 9 });
    p.videos.add(plan.videoSearches[1] ?? '', { youtubeId: `${slug.slice(0, 4)}vid0002`, durationMin: 14 });
    // Excluded by the rules: too long for a novice, and made for kids.
    p.videos.add(plan.videoSearches[1] ?? '', { youtubeId: `${slug.slice(0, 4)}long003`, durationMin: 95 });
    p.videos.add(plan.videoSearches[1] ?? '', { youtubeId: `${slug.slice(0, 4)}kids004`, madeForKids: true });
    const base = `https://${slug}.example`;
    p.web.finds.set(name, [
      { url: `${base}/guide?utm_source=x`, title: `${name} guide`, pageAge: 'March 1, 2026', type: 'article' },
      { url: `https://docs.${slug}.example/start`, title: `${name} docs`, pageAge: null, type: 'official_doc' },
      { url: `${base}/gone`, title: 'Dead link', pageAge: null, type: 'related' },
      { url: 'https://www.pinterest.com/pin/123', title: 'Pinned', pageAge: null, type: 'related' },
    ]);
    p.links.statuses.set(`${base}/gone`, 404);
    p.papers.papers.set(name, [
      { title: `On ${name}`, url: `https://arxiv.org/abs/2601.${slug.length}0001`, doi: null, arxivId: `2601.${slug.length}0001`, publishedAt: '2026-01-01', source: 'arXiv', abstract: `We study ${name}.` },
      { title: 'No identifier', url: `${base}/paper`, doi: null, arxivId: null, publishedAt: null, source: 'Blog', abstract: null },
    ]);
  }

  it('10 fixture topics yield at least 3 served resource types each, with 0 dead links', async () => {
    const p = pipeline(new Date('2026-10-23T12:00:00Z'));
    const names = ['Rust', 'Go', 'Linear algebra', 'Organic chemistry', 'Statistics', 'Photography', 'Public speaking', 'Kubernetes', 'Cooking', 'Microeconomics'];
    const stages: Stage[] = ['novice', 'advanced_beginner', 'competent', 'proficient', 'expert', 'novice', 'competent', 'proficient', 'advanced_beginner', 'competent'];
    for (const [i, name] of names.entries()) {
      const id = await topic(name);
      const full = `${name} ${tag}`;
      const stage = stages[i] as Stage;
      script(p, full, stage, `t${i}${tag}`);
      const pool = await p.run(id, stage);

      expect(pool?.status).toBe('ready');
      const served = await db.select({ type: resources.type, url: resources.url, deadAt: resources.deadAt, httpStatus: resources.httpStatus }).from(resources).where(inArray(resources.id, pool?.resourceIds ?? []));
      expect(new Set(served.map((r) => r.type)).size).toBeGreaterThanOrEqual(3);
      expect(served.filter((r) => r.deadAt !== null || r.httpStatus !== 200 || r.url.endsWith('/gone') || r.url.includes('pinterest'))).toEqual([]);
      // Videos longer than the stage allows (20 min for novices) and anything made for kids are left out;
      // papers come from competent up.
      expect(served.some((r) => r.url.includes('kids004'))).toBe(false);
      expect(served.some((r) => r.url.includes('long003'))).toBe(poolPlan(full, stage).maxVideoMin >= 95);
      expect(served.some((r) => r.type === 'paper')).toBe(['competent', 'proficient', 'expert'].includes(stage));
    }
    expect(p.ready).toHaveLength(10);
    expect(p.ready.every((e) => e.status === 'ready')).toBe(true);
    // Two search.list calls per discovery.
    expect(p.videos.searches).toHaveLength(20);
  }, 120_000);

  it('the YouTube guard stops at 90 calls a day and falls back to web-search videos confirmed by videos.list', async () => {
    const day = new Date('2026-11-02T18:00:00Z');
    const p = pipeline(day);
    await p.quota.exhaust(YOUTUBE_SEARCH_QUOTA, pacificDay(day), YOUTUBE_SEARCH_GUARD - 1);
    const id = await topic('Quota topic');
    const name = `Quota topic ${tag}`;
    script(p, name, 'novice', `q${tag}`);
    p.videos.videos.set('webvid00001', { youtubeId: 'webvid00001', title: 'From web search', channel: 'C', durationMin: 10, publishedAt: null, language: 'en', embeddable: true, public: true, madeForKids: false });
    p.web.finds.get(name)?.push({ url: 'https://www.youtube.com/watch?v=webvid00001', title: 'From web search', pageAge: null, type: 'related' });

    const pool = await p.run(id, 'novice');

    // One search left under the guard: one search.list call, then the fallback.
    expect(p.videos.searches).toHaveLength(1);
    expect(await p.quota.used(YOUTUBE_SEARCH_QUOTA, pacificDay(day))).toBe(YOUTUBE_SEARCH_GUARD);
    expect(pool?.videoFallback).toBe(true);
    expect(p.web.calls.at(-1)?.includeVideos).toBe(true);
    const urls = (await db.select({ url: resources.url }).from(resources).where(inArray(resources.id, pool?.resourceIds ?? []))).map((r) => r.url);
    expect(urls).toContain('https://www.youtube.com/watch?v=webvid00001');

    // At the guard: no search.list at all.
    const id2 = await topic('Quota topic two');
    script(p, `Quota topic two ${tag}`, 'novice', `q2${tag}`);
    await p.run(id2, 'novice');
    expect(p.videos.searches).toHaveLength(1);
  }, 60_000);

  it('a second topic reuses a URL analysed in the last 30 days without spending analysis or embedding', async () => {
    const p = pipeline(new Date('2026-10-24T12:00:00Z'));
    const shared = `https://shared-${tag}.example/intro`;
    const a = await topic('Reuse A');
    const b = await topic('Reuse B');
    for (const name of [`Reuse A ${tag}`, `Reuse B ${tag}`]) p.web.finds.set(name, [{ url: shared, title: 'Shared intro', pageAge: null, type: 'article' }]);

    await p.run(a, 'novice');
    const analysed = p.analyzer.calls.length;
    const embedded = p.embedder.requests.length;
    await p.run(b, 'novice');

    expect(p.analyzer.calls.length).toBe(analysed);
    expect(p.embedder.requests.length).toBe(embedded);
    const cards = await db.select({ topicId: resourceCards.topicId }).from(resourceCards).innerJoin(resources, eq(resources.id, resourceCards.resourceId)).where(eq(resources.url, shared));
    expect(cards.map((c) => c.topicId).sort()).toEqual([a, b].sort());
  }, 60_000);

  it('sends low-confidence cards to the review queue, drops cards under 60, and keeps the better of two duplicates', async () => {
    const p = pipeline(new Date('2026-10-25T12:00:00Z'));
    const id = await topic('Judged');
    const name = `Judged ${tag}`;
    const u = (s: string) => `https://judged-${tag}.example/${s}`;
    // The two duplicates share a title, takeaways and concepts, so they embed identically.
    p.web.finds.set(name, ['unsure', 'weak', 'dup-good', 'dup-worse'].map((s) => ({ url: u(s), title: s.startsWith('dup') ? 'Same guide' : s, pageAge: null, type: 'article' as const })));
    p.analyzer.overrides.set(u('unsure'), { confidence: 0.5, keyTakeaways: ['unsure'] });
    p.analyzer.overrides.set(u('weak'), { quality: { relevance: 50, accuracySignals: 55, recency: 60, teaching: 50 }, keyTakeaways: ['weak'] });
    p.analyzer.overrides.set(u('dup-good'), { keyTakeaways: ['same'], concepts: [{ name: 'same', start: null, end: null }], quality: { relevance: 95, accuracySignals: 90, recency: 90, teaching: 90 } });
    p.analyzer.overrides.set(u('dup-worse'), { keyTakeaways: ['same'], concepts: [{ name: 'same', start: null, end: null }] });

    await p.run(id, 'novice');

    const cards = await db.select({ url: resources.url, status: resourceCards.status, reason: resourceCards.reviewReason, id: resourceCards.id }).from(resourceCards).innerJoin(resources, eq(resources.id, resourceCards.resourceId)).where(eq(resourceCards.topicId, id));
    const status: Record<string, string> = Object.fromEntries(cards.map((c) => [c.url.split('/').at(-1) ?? '', c.status]));
    expect(status).toMatchObject({ unsure: 'review', weak: 'dropped' });
    // The better of the two stays served; the other is a duplicate (cosine 1 >= 0.95).
    expect({ good: status['dup-good'], worse: status['dup-worse'] }).toEqual({ good: 'served', worse: 'duplicate' });
    const flagged = await db.select().from(reviewItems).where(eq(reviewItems.targetId, cards.find((c) => c.url.endsWith('unsure'))?.id ?? ''));
    expect(flagged).toEqual([expect.objectContaining({ kind: 'resource', status: 'open' })]);
  }, 60_000);

  it('marks a link dead after two failed daily checks and publishes ResourceDead once', async () => {
    const p = pipeline(new Date('2026-10-26T12:00:00Z'));
    const [res] = await db.insert(resources).values({ url: `https://dies-${tag}.example/page`, type: 'article', title: 'Dies', source: 'dies.example' }).returning({ id: resources.id });
    if (!res) throw new Error('resource not created');
    p.links.statuses.set(`https://dies-${tag}.example/page`, 410);
    const check = new CheckLiveness(p.repo, p.links, p.videos, p.clock, p.bus);

    await check.run({ resourceId: res.id }, ctx());
    expect(p.dead).toHaveLength(0);
    await check.run({ resourceId: res.id }, ctx());
    await check.run({ resourceId: res.id }, ctx());

    expect(p.dead.map((e) => e.resourceId)).toEqual([res.id]);
    const [row] = await db.select().from(resources).where(eq(resources.id, res.id));
    expect(row).toMatchObject({ failedChecks: 2, httpStatus: 410 });
    expect(row?.deadAt).not.toBeNull();

    // The daily sweep queues live, unchecked resources and schedules the next day.
    const sweep = new LivenessSweep(p.repo, p.clock, { enqueue: (r: EnqueueRequest) => (p.queued.push(r), Promise.resolve({ job: { id: 'x' }, created: true })) } as unknown as JobQueue);
    await sweep.run({ day: '2026-10-26' });
    expect(p.queued.some((q) => q.type === CHECK_LIVENESS_JOB && (q.payload as { resourceId: string }).resourceId === res.id)).toBe(false);
    expect(p.queued.at(-1)).toMatchObject({ type: 'liveness-sweep', idempotencyKey: 'sweep:2026-10-27' });
  }, 60_000);

  it('logs searches, tokens and cost of the web search in llm_calls', async () => {
    const inner: WebSearcher = {
      search: () =>
        Promise.resolve({
          hits: [{ url: `https://metered-${tag}.example/a`, title: 'A', pageAge: null }],
          answer: null,
          queries: ['q'],
          call: { provider: 'anthropic', model: 'claude-haiku-5-5', usage: { inputTokens: 40_000, cacheWriteTokens: 0, cacheReadTokens: 0, outputTokens: 1_500 }, webSearchRequests: 6, latencyMs: 4_000 },
        }) as never,
    };
    const discovery = new ClaudeWebDiscovery(new MeteredWebSearcher(inner, new DrizzleLlmCallRecorder(db)), new PromptRegistry());

    const finds = await discovery.find({ topic: { id: randomUUID(), name: 'Metered', description: null, domain: 'software' }, stage: 'novice', max: 9, includeVideos: false });

    expect(finds.map((f) => f.url)).toEqual([`https://metered-${tag}.example/a`]);
    const [row] = await db.select().from(llmCalls).where(and(eq(llmCalls.stage, 'discover'), eq(llmCalls.promptName, 'web-discovery'), eq(llmCalls.latencyMs, 4_000)));
    // 40k x $0.1/M + 1.5k x $0.5/M = $0.00475, plus 6 searches x $0.01.
    expect(row).toMatchObject({ model: 'claude-haiku-5-5', webSearchRequests: 6, inputTokens: 40_000, outputTokens: 1_500, costUsd: '0.064750', status: 'ok' });
  });

  it('records every AI call of a discovery in llm_calls under its job (a missing row fails here)', async () => {
    // Prod-shaped wiring: metered adapters and real job rows (llm_calls.job_id references jobs). The
    // first smoke run lost every row to a placeholder job id; this test fails if rows go missing.
    const recorder = new DrizzleLlmCallRecorder(db);
    const jobs = new JobRepository(db);
    const realJob = async (type: string) => (await jobs.enqueue({ type: `int-${type}`, idempotencyKey: `${type}:${randomUUID()}`, payload: {} })).job.id;
    const p = pipeline(new Date('2026-10-27T12:00:00Z'));
    const id = await topic('Metered pool');
    const searcher: WebSearcher = {
      search: () =>
        Promise.resolve({
          hits: [
            { url: `https://metered-pool-${tag}.example/guide`, title: 'Guide', pageAge: null },
            { url: `https://docs.metered-pool-${tag}.example/`, title: 'Docs', pageAge: null },
          ],
          answer: { picks: [{ url: `https://metered-pool-${tag}.example/guide`, type: 'article' }, { url: `https://docs.metered-pool-${tag}.example/`, type: 'official_doc' }] },
          queries: ['q'],
          call: { provider: 'anthropic', model: 'claude-haiku-5-5', usage: { inputTokens: 8_000, cacheWriteTokens: 0, cacheReadTokens: 0, outputTokens: 400 }, webSearchRequests: 6, latencyMs: 10 },
        }) as never,
    };
    const valid = { dreyfusStage: 'novice', bloomLevels: ['C2'], prerequisites: [], concepts: [{ name: 'core', start: null, end: null }], keyTakeaways: ['k'], whyThis: 'w', readingMin: 5, language: 'en', quality: { relevance: 80, accuracySignals: 80, recency: 80, teaching: 80 }, evidence: 'e', confidence: 0.9 };
    const gemini: StructuredGenerator = {
      generate: <T,>(req: StructuredRequest<T>) =>
        Promise.resolve({ output: req.schema.parse({ ...valid, keyTakeaways: [req.input.slice(0, 40)] }), call: { provider: 'google' as const, model: req.model, usage: { inputTokens: 2_000, cacheWriteTokens: 0, cacheReadTokens: 0, outputTokens: 300 }, latencyMs: 10 } }),
    };
    const prompts = new PromptRegistry();
    const discover = new DiscoverResources(p.repo, p.videos, new ClaudeWebDiscovery(new MeteredWebSearcher(searcher, recorder), prompts), p.papers, p.links, p.quota, p.clock, new GetTopicProfileQuery(new DrizzleTopicRepository(db)), { assertCanStart: () => Promise.resolve() } as unknown as AiBudgetGuard, { enqueue: (r: EnqueueRequest) => (p.queued.push(r), Promise.resolve({ job: { id: 'x' }, created: true })) } as unknown as JobQueue, new UnitOfWork(db, p.bus));
    const analyse = new AnalyseResource(p.repo, new GeminiResourceAnalyzer(new MeteredStructuredGenerator({ anthropic: gemini, google: gemini }, recorder), prompts), p.links, new MeteredEmbedder(new FakeEmbedder(), 'gemini-embedding-2', recorder), p.clock, new GetTopicProfileQuery(new DrizzleTopicRepository(db)), new ReviewQueue(), new UnitOfWork(db, p.bus));

    const discoverJob = await realJob('discover');
    await discover.run(discover.parse({ topicId: id, stage: 'novice', poolVersion: 1 }), ctx(discoverJob));
    const analyseJobs: string[] = [];
    for (const job of p.queued.filter((q) => q.type === ANALYSE_RESOURCE_JOB).splice(0)) {
      const jobId = await realJob('analyse');
      analyseJobs.push(jobId);
      await analyse.run(analyse.parse(job.payload), ctx(jobId));
    }

    const rows = await db.select({ jobId: llmCalls.jobId, stage: llmCalls.stage, searches: llmCalls.webSearchRequests, cost: llmCalls.costUsd }).from(llmCalls).where(inArray(llmCalls.jobId, [discoverJob, ...analyseJobs]));
    expect(analyseJobs).toHaveLength(2);
    expect(rows.filter((r) => r.jobId === discoverJob)).toEqual([expect.objectContaining({ stage: 'discover', searches: 6 })]);
    // Each analysis: one Gemini call and one embedding.
    for (const jobId of analyseJobs) expect(rows.filter((r) => r.jobId === jobId).map((r) => r.stage).sort()).toEqual(['analyse', 'analyse']);
    // 8k x $0.1/M + 400 x $0.5/M + 6 searches x $0.01.
    expect(rows.find((r) => r.jobId === discoverJob)?.cost).toBe('0.061000');
  }, 60_000);

  it('never analyses an oversized video: a 3-hour one is skipped and the pool still settles', async () => {
    const p = pipeline(new Date('2026-10-28T12:00:00Z'));
    const id = await topic('Oversized');
    const [video] = await db
      .insert(resources)
      .values({ url: `https://www.youtube.com/watch?v=huge${tag.slice(0, 7)}`, type: 'youtube', title: 'Three-hour talk', source: 'C', youtubeId: `huge${tag.slice(0, 7)}`, durationMin: 180 })
      .returning({ id: resources.id });
    if (!video) throw new Error('resource not created');
    const pool = await db.transaction((tx) => p.repo.createPool(tx, { topicId: id, stage: 'expert', poolVersion: 1, candidateIds: [video.id], videoFallback: false, expiresAt: new Date('2026-11-28T00:00:00Z') }));
    const analyse = new AnalyseResource(p.repo, p.analyzer, p.links, p.embedder, p.clock, new GetTopicProfileQuery(new DrizzleTopicRepository(db)), new ReviewQueue(), new UnitOfWork(db, p.bus));

    const outcome = await analyse.run(analyse.parse({ poolId: pool.id, resourceId: video.id, topicId: id, stage: 'expert', abstract: null }), ctx());

    expect(outcome.result).toMatchObject({ outcome: 'skipped', poolSettled: true });
    expect(p.analyzer.calls).toHaveLength(0);
    expect(p.embedder.requests).toHaveLength(0);
    const [settled] = await db.select().from(discoveryResults).where(eq(discoveryResults.id, pool.id));
    expect(settled).toMatchObject({ status: 'thin', resourceIds: [] });
  });

  it('analyses a 45-minute video at a lower frame rate, inside the cap', async () => {
    const p = pipeline(new Date('2026-10-29T12:00:00Z'));
    const id = await topic('Long talk');
    const [video] = await db
      .insert(resources)
      .values({ url: `https://www.youtube.com/watch?v=long${tag.slice(0, 7)}`, type: 'youtube', title: 'Long talk', source: 'C', youtubeId: `long${tag.slice(0, 7)}`, durationMin: 45 })
      .returning({ id: resources.id });
    if (!video) throw new Error('resource not created');
    const pool = await db.transaction((tx) => p.repo.createPool(tx, { topicId: id, stage: 'proficient', poolVersion: 1, candidateIds: [video.id], videoFallback: false, expiresAt: new Date('2026-11-29T00:00:00Z') }));
    const analyse = new AnalyseResource(p.repo, p.analyzer, p.links, p.embedder, p.clock, new GetTopicProfileQuery(new DrizzleTopicRepository(db)), new ReviewQueue(), new UnitOfWork(db, p.bus));

    await analyse.run(analyse.parse({ poolId: pool.id, resourceId: video.id, topicId: id, stage: 'proficient', abstract: null }), ctx());

    expect(p.analyzer.calls).toHaveLength(1);
    expect(p.analyzer.calls[0]?.clip).toEqual({ fps: 0.25, endSec: null });
  });

  it("meters a paid discovery and its analyses under 'paid', and free spend at its cap does not block it", async () => {
    const recorder = new DrizzleLlmCallRecorder(db);
    const p = pipeline(new Date('2026-10-30T12:00:00Z'));
    const id = await topic('Paid pool');
    const searcher: WebSearcher = {
      search: () =>
        Promise.resolve({
          hits: [{ url: `https://paid-pool-${tag}.example/guide`, title: 'Guide', pageAge: null }],
          answer: { picks: [{ url: `https://paid-pool-${tag}.example/guide`, type: 'article' }] },
          queries: ['q'],
          call: { provider: 'anthropic', model: 'claude-haiku-5-5', usage: { inputTokens: 1_000, cacheWriteTokens: 0, cacheReadTokens: 0, outputTokens: 100 }, webSearchRequests: 2, latencyMs: 777 },
        }) as never,
    };
    // Free traffic has spent its whole budget today; paid has its own ceiling.
    const guard = new AiBudgetGuard({ spentSince: (_since: Date, scope: BudgetScope) => Promise.resolve(scope === 'free' ? 3 : 0) }, { free: 3, paid: 20 });
    await expect(guard.assertCanStart('cold', 'free')).rejects.toThrow();
    const discover = new DiscoverResources(p.repo, p.videos, new ClaudeWebDiscovery(new MeteredWebSearcher(searcher, recorder), new PromptRegistry()), p.papers, p.links, p.quota, p.clock, new GetTopicProfileQuery(new DrizzleTopicRepository(db)), guard, { enqueue: (r: EnqueueRequest) => (p.queued.push(r), Promise.resolve({ job: { id: 'x' }, created: true })) } as unknown as JobQueue, new UnitOfWork(db, p.bus));

    await discover.run(discover.parse({ topicId: id, stage: 'novice', poolVersion: 1, budgetScope: 'paid' }), ctx());

    const [row] = await db.select({ scope: llmCalls.budgetScope }).from(llmCalls).where(and(eq(llmCalls.stage, 'discover'), eq(llmCalls.latencyMs, 777)));
    expect(row?.scope).toBe('paid');
    const queued = p.queued.filter((q) => q.type === ANALYSE_RESOURCE_JOB);
    expect(queued.map((q) => (q.payload as { budgetScope: string }).budgetScope)).toEqual(['paid']);
  });
});

