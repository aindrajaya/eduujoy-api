import { Global, Module, type OnApplicationBootstrap, type OnApplicationShutdown } from '@nestjs/common';
import { AppConfig } from '../config';
import { JOB_EVENTS_HEARTBEAT_MS, JobEventsController } from './job-events.controller';
import { JobExecutor } from './job-executor';
import { JobQueue, JobSignals } from './job-queue';
import { JobRepository } from './job.repository';

/**
 * Jobs kernel (PRD-API §3, §5). Feature modules register their handlers on JobExecutor in onModuleInit;
 * the executor starts after bootstrap (resuming interrupted jobs) and drains on shutdown.
 */
@Global()
@Module({
  controllers: [JobEventsController],
  providers: [
    { provide: JOB_EVENTS_HEARTBEAT_MS, useValue: 20_000 },
    JobRepository,
    JobSignals,
    { provide: JobQueue, inject: [JobRepository, JobSignals], useFactory: (repo: JobRepository, signals: JobSignals) => new JobQueue(repo, signals) },
    {
      provide: JobExecutor,
      inject: [JobRepository, JobSignals, AppConfig],
      useFactory: (repo: JobRepository, signals: JobSignals, config: AppConfig) =>
        new JobExecutor(repo, signals, { problemBaseUrl: config.env.API_PUBLIC_URL }),
    },
  ],
  exports: [JobQueue, JobExecutor, JobRepository],
})
export class JobsModule implements OnApplicationBootstrap, OnApplicationShutdown {
  constructor(private readonly executor: JobExecutor) {}

  async onApplicationBootstrap(): Promise<void> {
    await this.executor.start();
  }

  async onApplicationShutdown(): Promise<void> {
    await this.executor.stop();
  }
}
