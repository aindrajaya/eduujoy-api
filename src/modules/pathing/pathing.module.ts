import { Inject, Module, type OnApplicationBootstrap, type OnModuleInit } from '@nestjs/common';
import { ReviewQueue } from '../../shared/common/review';
import { AppConfig } from '../../shared/config';
import { EventBus } from '../../shared/events';
import { JobExecutor, JobQueue } from '../../shared/jobs';
import { AssessmentModule } from '../assessment/assessment.module';
import { BillingModule } from '../billing/billing.module';
import { CatalogModule } from '../catalog/catalog.module';
import { DiscoveryModule } from '../discovery/discovery.module';
import { GeneratePath } from './application/generate-path.handler';
import { PATH_REFUND_SWEEP_CLOCK, PathRefundSweep, refundSweepRequest } from './application/path-refund-sweep.handler';
import { PathsQueries } from './application/paths.queries';
import { PATH_DESIGNER } from './application/ports/path-designer';
import { PATH_REPOSITORY } from './application/ports/path.repository';
import { RefundPathCharge } from './application/refund-path-charge.usecase';
import { RequestPath } from './application/request-path.usecase';
import { RefundRejectedPaths } from './application/review-resolved.listener';
import { WakeWaitingPaths } from './application/wake-waiting-paths.listener';
import { ClaudePathDesigner } from './infrastructure/claude-path-designer';
import { DrizzlePathRepository } from './infrastructure/drizzle-path.repository';
import { PathsController, StepsController } from './interface/paths.controller';

/** Pathing (PRD-API §4, A9): path requests, the generate-path job, reads and step progress. */
@Module({
  imports: [AssessmentModule, BillingModule, CatalogModule, DiscoveryModule],
  controllers: [PathsController, StepsController],
  providers: [
    RequestPath,
    PathsQueries,
    GeneratePath,
    RefundPathCharge,
    WakeWaitingPaths,
    PathRefundSweep,
    RefundRejectedPaths,
    { provide: PATH_REFUND_SWEEP_CLOCK, useValue: () => new Date() },
    ReviewQueue,
    { provide: PATH_REPOSITORY, useClass: DrizzlePathRepository },
    { provide: PATH_DESIGNER, useClass: ClaudePathDesigner },
  ],
})
export class PathingModule implements OnModuleInit, OnApplicationBootstrap {
  constructor(
    @Inject(JobExecutor) private readonly executor: JobExecutor,
    @Inject(EventBus) private readonly events: EventBus,
    @Inject(GeneratePath) private readonly generate: GeneratePath,
    @Inject(WakeWaitingPaths) private readonly wake: WakeWaitingPaths,
    @Inject(PathRefundSweep) private readonly sweep: PathRefundSweep,
    @Inject(RefundRejectedPaths) private readonly rejected: RefundRejectedPaths,
    @Inject(JobQueue) private readonly queue: JobQueue,
    @Inject(AppConfig) private readonly config: AppConfig,
  ) {}

  onModuleInit(): void {
    this.executor.register(this.generate);
    this.executor.register(this.sweep);
    this.wake.listen(this.events);
    this.rejected.listen(this.events);
  }

  async onApplicationBootstrap(): Promise<void> {
    // The hourly refund sweep chains itself; boot makes sure this hour's exists. Tests run it directly.
    if (this.config.env.NODE_ENV === 'test') return;
    await this.queue.enqueue(refundSweepRequest(new Date()));
  }
}
