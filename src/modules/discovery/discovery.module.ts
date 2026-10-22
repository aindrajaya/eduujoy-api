import { Inject, Module, type OnApplicationBootstrap, type OnModuleInit } from '@nestjs/common';
import { ReviewQueue } from '../../shared/common/review';
import { AppConfig } from '../../shared/config';
import { EventBus } from '../../shared/events';
import { JobExecutor, JobQueue } from '../../shared/jobs';
import { BillingModule } from '../billing/billing.module';
import { CatalogModule } from '../catalog/catalog.module';
import { AnalyseResource } from './application/analyse-resource.handler';
import { DiscoverResources } from './application/discover-resources.handler';
import { CheckLiveness, LivenessSweep, sweepRequest } from './application/liveness.handlers';
import { DISCOVERY_CLOCK, DISCOVERY_REPOSITORY } from './application/ports/discovery.repository';
import { LINK_CHECKER } from './application/ports/link-checker';
import { PAPER_SEARCH } from './application/ports/paper-search';
import { QUOTA_COUNTER } from './application/ports/quota-counter';
import { RESOURCE_ANALYZER } from './application/ports/resource-analyzer';
import { VIDEO_SEARCH } from './application/ports/video-search';
import { WEB_DISCOVERY } from './application/ports/web-discovery';
import { RequestDiscovery } from './application/request-discovery.usecase';
import { ClaudeWebDiscovery } from './infrastructure/claude-web-discovery';
import { DrizzleDiscoveryRepository } from './infrastructure/drizzle-discovery.repository';
import { DrizzleQuotaCounter } from './infrastructure/drizzle-quota.counter';
import { GeminiResourceAnalyzer } from './infrastructure/gemini-resource-analyzer';
import { HttpLinkChecker } from './infrastructure/http-link-checker';
import { OpenAlexAdapter } from './infrastructure/openalex.adapter';
import { YouTubeDataApiAdapter } from './infrastructure/youtube-data-api.adapter';

/**
 * Discovery (PRD-API §4, A8): YouTube, Claude web search and OpenAlex candidates, liveness, Gemini
 * analysis into ResourceCards, dedupe, and the shared topic + stage pools that pathing builds on.
 */
@Module({
  imports: [CatalogModule, BillingModule],
  providers: [
    RequestDiscovery,
    DiscoverResources,
    AnalyseResource,
    LivenessSweep,
    CheckLiveness,
    ReviewQueue,
    { provide: DISCOVERY_REPOSITORY, useClass: DrizzleDiscoveryRepository },
    { provide: QUOTA_COUNTER, useClass: DrizzleQuotaCounter },
    { provide: DISCOVERY_CLOCK, useValue: () => new Date() },
    { provide: VIDEO_SEARCH, inject: [AppConfig], useFactory: ({ env }: AppConfig) => new YouTubeDataApiAdapter(env.YOUTUBE_API_KEY) },
    { provide: PAPER_SEARCH, inject: [AppConfig], useFactory: ({ env }: AppConfig) => new OpenAlexAdapter(env.OPENALEX_API_KEY) },
    { provide: LINK_CHECKER, useFactory: () => new HttpLinkChecker() },
    { provide: WEB_DISCOVERY, useClass: ClaudeWebDiscovery },
    { provide: RESOURCE_ANALYZER, useClass: GeminiResourceAnalyzer },
  ],
  exports: [RequestDiscovery],
})
export class DiscoveryModule implements OnModuleInit, OnApplicationBootstrap {
  constructor(
    @Inject(JobExecutor) private readonly executor: JobExecutor,
    @Inject(JobQueue) private readonly queue: JobQueue,
    @Inject(EventBus) private readonly events: EventBus,
    @Inject(AppConfig) private readonly config: AppConfig,
    @Inject(RequestDiscovery) private readonly requestDiscovery: RequestDiscovery,
    @Inject(DiscoverResources) private readonly discover: DiscoverResources,
    @Inject(AnalyseResource) private readonly analyse: AnalyseResource,
    @Inject(LivenessSweep) private readonly sweep: LivenessSweep,
    @Inject(CheckLiveness) private readonly check: CheckLiveness,
  ) {}

  onModuleInit(): void {
    this.executor.register(this.discover);
    this.executor.register(this.analyse);
    this.executor.register(this.sweep);
    this.executor.register(this.check);
    this.requestDiscovery.listen(this.events);
  }

  async onApplicationBootstrap(): Promise<void> {
    // The daily liveness sweep chains itself; boot makes sure today's exists. Tests schedule their own.
    if (this.config.env.NODE_ENV === 'test') return;
    await this.queue.enqueue(sweepRequest(new Date().toISOString().slice(0, 10)));
  }
}
