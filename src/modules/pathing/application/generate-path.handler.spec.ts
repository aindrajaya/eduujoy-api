import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { type ReviewFlag, type ReviewQueue } from '../../../shared/common/review';
import { type DomainEvent, type UnitOfWork } from '../../../shared/events';
import { type JobContext, JobWaitExpiredError, RescheduleJob } from '../../../shared/jobs';
import { type GetTopicProfileQuery } from '../../catalog/application/get-topic-profile.query';
import { type PoolSnapshot, type ServedCard } from '../../discovery/application/ports/card.reader';
import { type RequestDiscovery } from '../../discovery/application/request-discovery.usecase';
import { type ServedCardsQuery } from '../../discovery/application/served-cards.query';
import { GeneratePath } from './generate-path.handler';
import { type GeneratePathPayload } from './jobs';
import { type DesignedPath, type DesignRequest, type PathDesigner } from './ports/path-designer';
import { type NewStep, type PathRecord, type PathRepository, type PathStatus } from './ports/path.repository';
import { type RefundPathCharge } from './refund-path-charge.usecase';

// A designer answer that passes every validator rule; claude-path-designer.spec checks it against the output schema.
const VALID = (JSON.parse(readFileSync(join(__dirname, '..', '..', '..', '..', 'test', 'fixtures', 'ai', 'path-designer-v1.valid.json'), 'utf8')) as { steps: DesignedPath['steps'] }).steps;
const PATH_ID = '11111111-1111-4111-8111-111111111111';
const TOPIC_ID = '22222222-2222-4222-8222-222222222222';

const card = (n: number, over: Partial<ServedCard> = {}): ServedCard => ({
  resourceId: `00000000-0000-4000-8000-00000000000${n}`,
  type: 'article',
  url: `https://example.com/${n}`,
  youtubeId: null,
  title: `Resource ${n}`,
  source: 'example.com',
  durationMin: null,
  readingMin: 10,
  published: null,
  language: 'en',
  stage: 'competent',
  bloomLevels: ['C3', 'C4'],
  prerequisites: [],
  concepts: [],
  keyTakeaways: ['t'],
  whyThis: null,
  quality: { relevance: 80, accuracySignals: 80, recency: 80, teaching: 80 },
  qualityScore: 80,
  ...over,
});

const PLACEMENT_CARDS = [card(1, { type: 'youtube', durationMin: 18, readingMin: null, stage: 'advanced_beginner', concepts: [{ name: 'Cleanup', start: '04:10', end: '07:45' }] }), card(2, { stage: 'advanced_beginner' })];
const TARGET_CARDS = [card(3, { type: 'official_doc' }), card(4), card(5, { type: 'paper' }), card(2, { stage: 'advanced_beginner' })];

const pool = (status: PoolSnapshot['status'], over: Partial<PoolSnapshot> = {}): PoolSnapshot => ({
  id: 'pool',
  status,
  poolVersion: 1,
  expiresAt: new Date(Date.now() + 86_400_000),
  candidates: 10,
  analysed: status === 'analysing' ? 4 : 10,
  resourceIds: [],
  ...over,
});

function setup(opts: { designs?: DesignedPath['steps'][]; pools?: Partial<Record<string, { pool: PoolSnapshot | null; cards: ServedCard[] }>>; status?: PathStatus; discovery?: string } = {}) {
  const path: PathRecord = {
    id: PATH_ID,
    userId: 'u-1',
    topicId: TOPIC_ID,
    placementId: 'pl-1',
    from: { stage: 'advanced_beginner', bloom: 'C3' },
    to: { stage: 'competent', bloom: 'C4' },
    status: opts.status ?? 'generating',
    goal: 'Ship a dashboard',
    weeklyHours: 4,
    jobId: 'job-1',
    refundedAt: null,
    createdAt: new Date(),
    updatedAt: new Date(),
  };
  const saved: NewStep[][] = [];
  const statuses: [PathStatus, PathStatus][] = [];
  const repo = {
    findById: () => Promise.resolve(path),
    activate: (_tx: unknown, _id: string, steps: NewStep[]) => {
      saved.push(steps);
      path.status = 'active';
      return Promise.resolve(true);
    },
    setStatus: (_tx: unknown, _id: string, from: PathStatus, to: PathStatus) => {
      statuses.push([from, to]);
      return Promise.resolve(path.status === from && ((path.status = to), true));
    },
    steps: () =>
      Promise.resolve(
        (saved[0] ?? []).map((s, i) => ({ ...s, id: `s${i + 1}`, pathId: PATH_ID, status: i === 0 ? ('active' as const) : ('locked' as const), remedial: false, difficulty: null })),
      ),
  } as unknown as PathRepository;
  const requests: DesignRequest[] = [];
  const designs = [...(opts.designs ?? [VALID])];
  const designer: PathDesigner = {
    design: (r) => {
      requests.push(r);
      return Promise.resolve({ steps: designs.shift() ?? VALID, model: 'claude-sonnet-5-5', promptVersion: 'v1' });
    },
  };
  const pools = { advanced_beginner: { pool: pool('ready'), cards: PLACEMENT_CARDS }, competent: { pool: pool('ready'), cards: TARGET_CARDS }, ...opts.pools };
  const served = { pool: (_t: string, stage: string) => Promise.resolve(pools[stage as keyof typeof pools]) } as unknown as ServedCardsQuery;
  const discoveryCalls: unknown[] = [];
  const discovery = { execute: (i: unknown) => (discoveryCalls.push(i), Promise.resolve(opts.discovery ?? 'queued')) } as unknown as RequestDiscovery;
  const topics = { execute: () => Promise.resolve({ id: TOPIC_ID, canonicalName: 'React hooks', domain: 'software', aliases: [], parentId: null, description: null }) } as unknown as GetTopicProfileQuery;
  const flags: ReviewFlag[] = [];
  const reviews = { flag: (_tx: unknown, f: ReviewFlag) => (flags.push(f), Promise.resolve()) } as unknown as ReviewQueue;
  const events: DomainEvent[] = [];
  const uow = { run: (work: (tx: unknown, scope: { publish: (e: DomainEvent) => void; afterCommit: () => void }) => Promise<unknown>) => work({}, { publish: (e) => events.push(e), afterCommit: () => undefined }) } as unknown as UnitOfWork;
  const refunds: unknown[][] = [];
  const refund = { execute: (...args: unknown[]) => (refunds.push(args), Promise.resolve('refunded')) } as unknown as RefundPathCharge;
  const progress: [string, number, number, string | undefined][] = [];
  const partials: Record<string, unknown>[] = [];
  const ctx: JobContext = {
    jobId: 'job-1',
    attempt: 1,
    maxAttempts: 3,
    signal: new AbortController().signal,
    progress: (stage, done, total, message) => (progress.push([stage, done, total, message]), Promise.resolve()),
    partial: (data) => (partials.push(data), Promise.resolve()),
  };
  const handler = new GeneratePath(repo, designer, served, discovery, topics, reviews, uow, refund, { language: 'en' });
  const payload: GeneratePathPayload = { pathId: PATH_ID, topicId: TOPIC_ID, stages: ['advanced_beginner', 'competent'], budgetScope: 'paid', formats: [] };
  return { handler, payload, ctx, path, saved, statuses, requests, discoveryCalls, flags, events, refunds, progress, partials };
}

describe('GeneratePath (A9)', () => {
  it('designs from both pools, saves the steps, publishes PathGenerated and sends step 1 early', async () => {
    const t = setup();

    await expect(t.handler.run(t.payload, t.ctx)).resolves.toEqual({ resultRef: `/v1/paths/${PATH_ID}` });

    // Placement-stage cards first, then the target's, without the duplicate resource 2.
    expect(t.requests[0]?.cards.map((c) => [c.alias, c.title])).toEqual([
      ['r1', 'Resource 1'],
      ['r2', 'Resource 2'],
      ['r3', 'Resource 3'],
      ['r4', 'Resource 4'],
      ['r5', 'Resource 5'],
    ]);
    expect(t.requests[0]).toMatchObject({ target: 'competent', budgetMinutes: 480, formats: [], formatFallback: false, budgetScope: 'paid', jobId: 'job-1' });
    expect(t.requests[0]?.feedback).toBeUndefined();
    const steps = t.saved[0] ?? [];
    expect(steps).toHaveLength(6);
    expect(steps[0]).toMatchObject({ resourceIds: [card(1).resourceId], actions: [{ n: 1, text: 'Watch the cleanup section. (4:10–7:45)', done: false }, { n: 2 }] });
    expect(steps[0]?.checkpoint.items).toEqual([
      { id: 'i1', kind: 'single_choice', prompt: expect.any(String) as string, options: expect.any(Array) as unknown[] },
      { id: 'i2', kind: 'open', prompt: 'Explain what your change fixed.' },
    ]);
    expect(steps[0]?.answerKeys[0]).toEqual({ correctOptionIds: ['b'], expectedAnswer: null });
    expect(t.events.map((e) => e.type)).toEqual(['PathGenerated']);
    expect(t.flags).toEqual([]);
    expect(t.partials).toHaveLength(1);
    expect(t.partials[0]).toMatchObject({ kind: 'path_step', pathId: PATH_ID, step: { n: 1, status: 'active', resources: [{ id: card(1).resourceId, type: 'youtube' }] } });
    expect(JSON.stringify(t.partials)).not.toContain('correctOptionIds');
  });

  it('notes in step 1 when the preferred format has too few resources, and drops other-language cards', async () => {
    const t = setup({ pools: { advanced_beginner: { pool: pool('ready'), cards: [...PLACEMENT_CARDS, card(6, { language: 'id', stage: 'advanced_beginner' })] } } });

    await t.handler.run({ ...t.payload, formats: ['papers'] }, t.ctx);
    expect(t.requests[0]?.cards.map((c) => c.title)).not.toContain('Resource 6');
    expect(t.requests[0]).toMatchObject({ formats: ['papers'], formatFallback: true });
    expect(t.saved[0]?.[0]?.actions[0]?.text).toMatch(/^Note: this topic has few resources in your preferred format yet/);
    expect(t.saved[0]?.[1]?.actions[0]?.text).not.toMatch(/^Note:/);
  });

  it('gives the designer the concepts its cards teach, most common first', async () => {
    const withConcepts = (n: number, names: string[]) => card(n, { stage: 'competent', concepts: names.map((name) => ({ name, start: null, end: null })) });
    const t = setup({ pools: { competent: { pool: pool('ready'), cards: [withConcepts(3, ['Effects', 'Cleanup']), withConcepts(4, ['Effects']), withConcepts(5, ['Reducers', 'effects'])] } } });

    await t.handler.run(t.payload, t.ctx);
    expect(t.requests[0]?.coreConcepts.slice(0, 3)).toEqual(['Effects', 'Cleanup', 'Reducers']);
  });

  it('regenerates once with the validator errors, then saves', async () => {
    const broken = VALID.map((s, i) => (i === 1 ? { ...s, resources: ['r9'] } : s));
    const t = setup({ designs: [broken, VALID] });

    await t.handler.run(t.payload, t.ctx);
    expect(t.requests).toHaveLength(2);
    expect(t.requests[1]?.feedback).toEqual(['Step 2 cites r9, which is not in the resource list; use only the listed resources.']);
    expect(t.saved).toHaveLength(1);
  });

  it('sends a path that fails twice to review and still completes the job', async () => {
    const broken = VALID.map((s) => ({ ...s, bloom: 'C6' as const }));
    const t = setup({ designs: [broken, broken] });

    await expect(t.handler.run(t.payload, t.ctx)).resolves.toEqual({ resultRef: `/v1/paths/${PATH_ID}` });
    expect(t.saved).toEqual([]);
    expect(t.statuses).toEqual([['generating', 'under_review']]);
    expect(t.flags[0]).toMatchObject({ kind: 'path', targetId: PATH_ID, reason: 'validation_failed', detail: { errors: expect.arrayContaining([expect.stringContaining('C6')]) as unknown[] } });
    expect(t.events).toEqual([]);
  });

  it('flags a path with fewer than three resource types but keeps it active', async () => {
    const one = (n: number) => card(n, { stage: 'competent' });
    const textOnly = VALID.map((s) => ({ ...s, actions: s.actions.map((a) => ({ ...a, resource: null, startSec: null, endSec: null })) }));
    const run = setup({ designs: [textOnly], pools: { advanced_beginner: { pool: pool('ready'), cards: [one(1), one(2)] }, competent: { pool: pool('ready'), cards: [one(3), one(4), one(5)] } } });

    await run.handler.run(run.payload, run.ctx);
    expect(run.saved).toHaveLength(1);
    expect(run.flags).toEqual([{ kind: 'path', targetId: PATH_ID, reason: 'few_resource_types' }]);
  });

  it('waits without an attempt while a pool analyses, reporting progress', async () => {
    const t = setup({ pools: { competent: { pool: pool('analysing'), cards: [] } } });

    await expect(t.handler.run(t.payload, t.ctx)).rejects.toBeInstanceOf(RescheduleJob);
    expect(t.progress).toEqual([['analyse', 4, 10, '4 of 10 resources analysed']]);
    expect(t.requests).toEqual([]);
  });

  it('requests a missing or expired pool as charged, then waits', async () => {
    const t = setup({ pools: { advanced_beginner: { pool: null, cards: [] }, competent: { pool: pool('ready', { expiresAt: new Date(Date.now() - 1000) }), cards: [] } } });

    await expect(t.handler.run(t.payload, t.ctx)).rejects.toBeInstanceOf(RescheduleJob);
    expect(t.discoveryCalls).toEqual([
      { topicId: TOPIC_ID, stage: 'advanced_beginner', userId: 'u-1', charged: { budgetScope: 'paid' } },
      { topicId: TOPIC_ID, stage: 'competent', userId: 'u-1', charged: { budgetScope: 'paid' } },
    ]);
    expect(t.progress).toEqual([['discover', 0, 1, 'Finding resources']]);
  });

  it('fails with AI_BUDGET_EXCEEDED when the scope cannot pay for a missing pool', async () => {
    const t = setup({ pools: { competent: { pool: null, cards: [] } }, discovery: 'over_budget' });

    await expect(t.handler.run(t.payload, t.ctx)).rejects.toMatchObject({ code: 'AI_BUDGET_EXCEEDED' });
  });

  it('does nothing for a path that is already settled', async () => {
    const t = setup({ status: 'active' });

    await expect(t.handler.run(t.payload, t.ctx)).resolves.toEqual({ resultRef: `/v1/paths/${PATH_ID}` });
    expect(t.requests).toEqual([]);
  });

  it('refunds once dead, naming the wait cap when that is why', async () => {
    const t = setup();

    await t.handler.onDead(t.payload, { jobId: 'job-1', error: new Error('upstream') });
    await t.handler.onDead(t.payload, { jobId: 'job-1', error: new JobWaitExpiredError('pools never arrived') });
    expect(t.refunds).toEqual([
      [PATH_ID, 'generation_failed', { from: 'generating' }],
      [PATH_ID, 'wait_expired', { from: 'generating' }],
    ]);
  });
});
