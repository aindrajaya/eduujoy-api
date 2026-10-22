import { Inject, Injectable, Logger } from '@nestjs/common';
import { AiBudgetExceededError, AiBudgetGuard, AiCallError } from '../../../shared/ai';
import { UnitOfWork } from '../../../shared/events';
import { type JobContext, type JobHandler, type JobOutcome, JobQueue, NonRetryableJobError } from '../../../shared/jobs';
import { GetTopicProfileQuery } from '../../catalog/application/get-topic-profile.query';
import {
  BLOCKED_DOMAINS,
  hostOf,
  isBlocked,
  isRecognisedPaper,
  normaliseUrl,
  POOL_TTL_DAYS,
  type PoolPlan,
  poolPlan,
  ResourcesReady,
  YOUTUBE_SEARCH_GUARD,
  YOUTUBE_SEARCH_QUOTA,
  pacificDay,
  youtubeIdFromUrl,
  youtubeUrl,
} from '../domain';
import { ANALYSE_RESOURCE_JOB, type AnalysePayload, DAY_MS, discoverPayload, type DiscoverPayload, DISCOVER_RESOURCES_JOB, mapLimit } from './jobs';
import { type Clock, DISCOVERY_CLOCK, DISCOVERY_REPOSITORY, type DiscoveryRepository, type NewResource } from './ports/discovery.repository';
import { LINK_CHECKER, type LinkChecker } from './ports/link-checker';
import { type Paper, PAPER_SEARCH, type PaperSearch } from './ports/paper-search';
import { QUOTA_COUNTER, type QuotaCounter } from './ports/quota-counter';
import { type VideoDetails, VIDEO_SEARCH, VideoQuotaExceededError, type VideoSearch } from './ports/video-search';
import { type DiscoveryTopic, WEB_DISCOVERY, type WebDiscovery, type WebFind } from './ports/web-discovery';

/** Results asked of each `search.list` call. */
const VIDEOS_PER_SEARCH = 5;
/** PRD-API §5: liveness checks run four at a time. */
const LINK_CONCURRENCY = 4;
/** Extra web results asked for, to cover dead links and video URLs. */
const WEB_HEADROOM = 4;

interface Candidate {
  resource: NewResource;
  abstract: string | null;
}

/**
 * `discover-resources` (PRD-API §5, FR-06 to FR-08): searches YouTube, Claude web search and OpenAlex
 * for one topic and stage, keeps only live links, stores the resources and the pool, and enqueues one
 * `analyse-resource` job per resource, all in one transaction. Re-running a finished pool does nothing.
 */
@Injectable()
export class DiscoverResources implements JobHandler<DiscoverPayload> {
  readonly type = DISCOVER_RESOURCES_JOB;
  readonly concurrency = 2;
  readonly timeoutMs = 120_000;
  private readonly logger = new Logger(DiscoverResources.name);

  constructor(
    @Inject(DISCOVERY_REPOSITORY) private readonly repo: DiscoveryRepository,
    @Inject(VIDEO_SEARCH) private readonly videos: VideoSearch,
    @Inject(WEB_DISCOVERY) private readonly web: WebDiscovery,
    @Inject(PAPER_SEARCH) private readonly papers: PaperSearch,
    @Inject(LINK_CHECKER) private readonly links: LinkChecker,
    @Inject(QUOTA_COUNTER) private readonly quota: QuotaCounter,
    @Inject(DISCOVERY_CLOCK) private readonly clock: Clock,
    private readonly topics: GetTopicProfileQuery,
    private readonly budget: AiBudgetGuard,
    private readonly queue: JobQueue,
    private readonly uow: UnitOfWork,
  ) {}

  parse(payload: unknown): DiscoverPayload {
    return discoverPayload.parse(payload);
  }

  async run(payload: DiscoverPayload, ctx: JobContext): Promise<JobOutcome> {
    const resultRef = `/discovery/${payload.topicId}/${payload.stage}/${payload.poolVersion}`;
    const existing = await this.repo.findPool(payload.topicId, payload.stage, payload.poolVersion);
    if (existing) return { resultRef, result: { poolId: existing.id, candidates: existing.candidateIds.length } };

    try {
      await this.budget.assertCanStart('cold', payload.budgetScope);
    } catch (error) {
      if (error instanceof AiBudgetExceededError) throw new NonRetryableJobError(error.message);
      throw error;
    }
    const profile = await this.topics.execute(payload.topicId);
    if (!profile) throw new NonRetryableJobError(`Unknown topic ${payload.topicId}`);
    const topic: DiscoveryTopic = { id: profile.id, name: profile.canonicalName, description: profile.description, domain: profile.domain };
    const plan = poolPlan(topic.name, payload.stage);

    await ctx.progress('discover', 0, 3, 'Searching videos, articles and papers');
    const searches = await this.takeVideoSearches(plan);
    const videoFallback = searches.length < plan.videoSearches.length;
    const [videoIds, webFinds, papers] = await Promise.all([
      this.searchVideos(searches, plan, ctx.signal),
      this.findWeb(topic, payload, plan, videoFallback, ctx),
      plan.paperQuery ? this.searchPapers(plan.paperQuery, ctx.signal) : Promise.resolve([]),
    ]);

    await ctx.progress('discover', 1, 3, 'Checking links');
    const now = this.clock();
    const webVideoIds = webFinds.map((f) => youtubeIdFromUrl(f.url)).filter((id): id is string => id !== null);
    const candidates: Candidate[] = [
      ...(await this.keepVideos([...videoIds, ...webVideoIds], plan, now, ctx.signal)),
      ...(await this.keepWeb(webFinds, plan, now, ctx.signal)),
      ...(await this.keepPapers(papers, plan, now, ctx.signal)),
    ];

    await ctx.progress('discover', 2, 3, `Found ${candidates.length} resources`);
    const poolId = await this.uow.run(async (tx, scope) => {
      const ids = await this.repo.upsertResources(tx, candidates.map((c) => c.resource));
      const candidateIds = [...new Set(candidates.map((c) => ids.get(c.resource.url)).filter((id): id is string => id !== undefined))];
      const pool = await this.repo.createPool(tx, {
        topicId: payload.topicId,
        stage: payload.stage,
        poolVersion: payload.poolVersion,
        candidateIds,
        videoFallback,
        expiresAt: new Date(now.getTime() + POOL_TTL_DAYS * DAY_MS),
      });
      if (candidateIds.length === 0) {
        // Nothing to analyse: a thin pool, retried after a day instead of 30.
        await this.repo.settlePool(tx, pool.id, 'thin', [], new Date(now.getTime() + DAY_MS));
        scope.publish(new ResourcesReady(pool.id, payload.topicId, payload.stage, payload.poolVersion, 'thin', []));
        return pool.id;
      }
      for (const candidate of candidates) {
        const resourceId = ids.get(candidate.resource.url);
        if (!resourceId) continue;
        const analyse: AnalysePayload = { poolId: pool.id, resourceId, topicId: payload.topicId, stage: payload.stage, abstract: candidate.abstract, budgetScope: payload.budgetScope };
        await this.queue.enqueue(
          { type: ANALYSE_RESOURCE_JOB, idempotencyKey: `${pool.id}:${resourceId}`, payload: analyse, userId: null, maxAttempts: 3 },
          { tx, scope },
        );
      }
      return pool.id;
    });

    await ctx.progress('discover', 3, 3);
    this.logger.log({ topicId: payload.topicId, stage: payload.stage, poolId, candidates: candidates.length, videoFallback }, 'Discovery pool created');
    return { resultRef, result: { poolId, candidates: candidates.length, videoFallback } };
  }

  /** The `search.list` calls the daily guard allows for this discovery (master PRD §14 fallback). */
  private async takeVideoSearches(plan: PoolPlan): Promise<string[]> {
    const day = pacificDay(this.clock());
    const allowed: string[] = [];
    for (const query of plan.videoSearches) {
      if (!(await this.quota.tryTake(YOUTUBE_SEARCH_QUOTA, day, YOUTUBE_SEARCH_GUARD))) break;
      allowed.push(query);
    }
    return allowed;
  }

  private async searchVideos(queries: string[], plan: PoolPlan, signal: AbortSignal): Promise<string[]> {
    const ids: string[] = [];
    for (const query of queries) {
      try {
        ids.push(...(await this.videos.search({ query, maxResults: VIDEOS_PER_SEARCH, duration: plan.videoDuration, signal })));
      } catch (error) {
        if (error instanceof VideoQuotaExceededError) {
          await this.quota.exhaust(YOUTUBE_SEARCH_QUOTA, pacificDay(this.clock()), YOUTUBE_SEARCH_GUARD);
          break;
        }
        this.warn('YouTube search failed', error);
      }
    }
    return ids;
  }

  /** A transient web search failure retries the job; a permanent one (refusal, bad request) leaves web results out. */
  private async findWeb(topic: DiscoveryTopic, payload: DiscoverPayload, plan: PoolPlan, includeVideos: boolean, ctx: JobContext): Promise<WebFind[]> {
    try {
      return await this.web.find({ topic, stage: payload.stage, max: plan.maxWeb + WEB_HEADROOM, includeVideos, jobId: ctx.jobId, budgetScope: payload.budgetScope, signal: ctx.signal });
    } catch (error) {
      if (error instanceof AiCallError && !error.retryable) {
        this.warn('Web discovery failed', error);
        return [];
      }
      throw error;
    }
  }

  private async searchPapers(query: string, signal: AbortSignal): Promise<Paper[]> {
    try {
      return await this.papers.search({ query, limit: 8, signal });
    } catch (error) {
      this.warn('Paper search failed', error);
      return [];
    }
  }

  /** Confirmed through `videos.list` (master PRD §12), public, embeddable, not made for kids, within the stage's length. */
  private async keepVideos(ids: string[], plan: PoolPlan, now: Date, signal: AbortSignal): Promise<Candidate[]> {
    const unique = [...new Set(ids)].slice(0, 50);
    if (unique.length === 0) return [];
    let details: VideoDetails[];
    try {
      details = await this.videos.details(unique, signal);
    } catch (error) {
      this.warn('YouTube videos.list failed', error);
      return [];
    }
    const byId = new Map(details.map((d) => [d.youtubeId, d]));
    return unique
      .map((id) => byId.get(id))
      .filter((d): d is VideoDetails => d !== undefined && d.public && d.embeddable && !d.madeForKids && d.durationMin >= 2 && d.durationMin <= plan.maxVideoMin)
      .slice(0, plan.maxVideos)
      .map((d) => ({
        resource: {
          url: youtubeUrl(d.youtubeId),
          type: 'youtube' as const,
          title: d.title,
          source: d.channel,
          youtubeId: d.youtubeId,
          durationMin: d.durationMin,
          publishedAt: d.publishedAt,
          language: d.language,
          metadataFetchedAt: now,
          httpStatus: 200,
          checkedAt: now,
        },
        abstract: null,
      }));
  }

  /** Articles and docs: https, not on the deny list, answering 2xx right now (master PRD §12). */
  private async keepWeb(finds: WebFind[], plan: PoolPlan, now: Date, signal: AbortSignal): Promise<Candidate[]> {
    const seen = new Set<string>();
    const usable: (WebFind & { url: string })[] = [];
    for (const find of finds) {
      const url = normaliseUrl(find.url);
      if (!url || seen.has(url) || youtubeIdFromUrl(url) || isBlocked(url, BLOCKED_DOMAINS)) continue;
      seen.add(url);
      usable.push({ ...find, url });
    }
    const checks = await mapLimit(usable, LINK_CONCURRENCY, (f) => this.links.check(f.url, signal));
    return usable
      .filter((_, i) => checks[i]?.ok)
      .slice(0, plan.maxWeb)
      .map((f) => ({
        resource: { url: f.url, type: f.type, title: f.title.slice(0, 300), source: hostOf(f.url), pageAge: f.pageAge, httpStatus: 200, checkedAt: now },
        abstract: null,
      }));
  }

  private async keepPapers(papers: Paper[], plan: PoolPlan, now: Date, signal: AbortSignal): Promise<Candidate[]> {
    const usable = papers
      .filter(isRecognisedPaper)
      .map((p) => ({ ...p, url: normaliseUrl(p.url) }))
      .filter((p): p is Paper & { url: string } => p.url !== null);
    const checks = await mapLimit(usable, LINK_CONCURRENCY, (p) => this.links.check(p.url, signal));
    return usable
      .filter((_, i) => checks[i]?.ok)
      .slice(0, plan.maxPapers)
      .map((p) => ({
        resource: { url: p.url, type: 'paper' as const, title: p.title.slice(0, 300), source: p.source, publishedAt: p.publishedAt, httpStatus: 200, checkedAt: now },
        abstract: p.abstract,
      }));
  }

  private warn(message: string, error: unknown): void {
    this.logger.warn({ err: error instanceof Error ? error : new Error(String(error)) }, message);
  }
}

