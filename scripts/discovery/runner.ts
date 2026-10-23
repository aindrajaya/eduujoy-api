// Shared wiring for the operator discovery scripts (discovery:smoke, discovery:pregen): real adapters,
// metered with no job id, handlers run inline (never queued, so a running API cannot pick their jobs up).
// Wired by hand: tsx emits no decorator metadata, so Nest DI can't run under it.
import Anthropic from '@anthropic-ai/sdk';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { type Pool } from 'pg';
import { GetTopicProfileQuery } from '../../src/modules/catalog/application/get-topic-profile.query';
import { DrizzleTopicRepository } from '../../src/modules/catalog/infrastructure/drizzle-topic.repository';
import { AnalyseResource } from '../../src/modules/discovery/application/analyse-resource.handler';
import { DiscoverResources } from '../../src/modules/discovery/application/discover-resources.handler';
import { ClaudeWebDiscovery } from '../../src/modules/discovery/infrastructure/claude-web-discovery';
import { DrizzleDiscoveryRepository } from '../../src/modules/discovery/infrastructure/drizzle-discovery.repository';
import { DrizzleQuotaCounter } from '../../src/modules/discovery/infrastructure/drizzle-quota.counter';
import { GeminiResourceAnalyzer } from '../../src/modules/discovery/infrastructure/gemini-resource-analyzer';
import { HttpLinkChecker } from '../../src/modules/discovery/infrastructure/http-link-checker';
import { OpenAlexAdapter } from '../../src/modules/discovery/infrastructure/openalex.adapter';
import { YouTubeDataApiAdapter } from '../../src/modules/discovery/infrastructure/youtube-data-api.adapter';
import { AiBudgetGuard, EMBEDDING_MODEL, PromptRegistry } from '../../src/shared/ai';
import { ClaudeStructuredGenerator } from '../../src/shared/ai/claude/claude.generator';
import { ClaudeWebSearcher } from '../../src/shared/ai/claude/claude.web-search';
import { createGeminiClient, GeminiEmbedder, GeminiStructuredGenerator } from '../../src/shared/ai/gemini/gemini.adapters';
import { DrizzleLlmCallRecorder } from '../../src/shared/ai/metering/llm-call.recorder';
import { MeteredEmbedder, MeteredStructuredGenerator, MeteredWebSearcher } from '../../src/shared/ai/metering/metered';
import { TallyingRecorder } from '../../src/shared/ai/metering/tallying.recorder';
import { ReviewQueue } from '../../src/shared/common/review';
import { createDatabase } from '../../src/shared/db';
import { EventBus } from '../../src/shared/events/event-bus';
import { UnitOfWork } from '../../src/shared/events/unit-of-work';
import { type EnqueueRequest, type JobContext, type JobQueue } from '../../src/shared/jobs';

export interface Smoke {
  db: ReturnType<typeof createDatabase>;
  meter: TallyingRecorder;
  discover: DiscoverResources;
  analyse: AnalyseResource;
  queued: EnqueueRequest[];
  repo: DrizzleDiscoveryRepository;
  videos: YouTubeDataApiAdapter;
  links: HttpLinkChecker;
  quota: DrizzleQuotaCounter;
}

export function buildSmoke(client: Pool, keys: { anthropic: string; gemini: string; youtube: string; openalex: string }, capUsd: number): Smoke {
  const db = createDatabase(client);
  // Handlers run inline here, outside the jobs table, so llm_calls rows carry no job id.
  const meter = new TallyingRecorder(new DrizzleLlmCallRecorder(db), { detachJobs: true });
  const anthropic = new Anthropic({ apiKey: keys.anthropic });
  const gemini = createGeminiClient(keys.gemini);
  const prompts = new PromptRegistry();
  const generator = new MeteredStructuredGenerator({ anthropic: new ClaudeStructuredGenerator(anthropic), google: new GeminiStructuredGenerator(gemini) }, meter);
  const embedder = new MeteredEmbedder(new GeminiEmbedder(gemini), EMBEDDING_MODEL, meter);
  const web = new ClaudeWebDiscovery(new MeteredWebSearcher(new ClaudeWebSearcher(anthropic), meter), prompts);
  const videos = new YouTubeDataApiAdapter(keys.youtube);
  const links = new HttpLinkChecker();
  const repo = new DrizzleDiscoveryRepository(db);
  const quota = new DrizzleQuotaCounter(db);
  const uow = new UnitOfWork(db, new EventBus(new EventEmitter2()));
  const topicQuery = new GetTopicProfileQuery(new DrizzleTopicRepository(db));
  // The smoke's own cap is the budget: discovery refuses to start once the run has spent it.
  // The smoke runs as `operator` (its own cap below), so the daily scopes never stop it.
  const budget = new AiBudgetGuard({ spentSince: () => Promise.resolve(meter.total) }, { free: capUsd, paid: capUsd });
  const queued: EnqueueRequest[] = [];
  const queue = { enqueue: (r: EnqueueRequest) => (queued.push(r), Promise.resolve({ job: { id: 'inline' }, created: true })) } as unknown as JobQueue;
  const clock = (): Date => new Date();
  const discover = new DiscoverResources(repo, videos, web, new OpenAlexAdapter(keys.openalex), links, quota, clock, topicQuery, budget, queue, uow);
  const analyse = new AnalyseResource(repo, new GeminiResourceAnalyzer(generator, prompts), links, embedder, clock, topicQuery, new ReviewQueue(), uow);
  return { db, meter, discover, analyse, queued, repo, videos, links, quota };
}

export const ctx = (signal: AbortSignal): JobContext => ({
  jobId: 'smoke',
  attempt: 3,
  maxAttempts: 3,
  signal,
  progress: () => Promise.resolve(),
  partial: () => Promise.resolve(),
});


export function env(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} must be in the environment (run with node --env-file=.env)`);
  return value;
}
