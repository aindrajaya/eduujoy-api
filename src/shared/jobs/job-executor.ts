import { Logger } from '@nestjs/common';
import { toProblem } from '../common/problem/problem';
import { type JobSignals } from './job-queue';
import { type JobEventListener, type JobHandler, NonRetryableJobError } from './job-handler';
import { type JobRepository } from './job.repository';
import { type JobEventType, type JobRecord } from './job.types';

export interface ExecutorOptions {
  /** Base URL for problem `type` links in failed events (API_PUBLIC_URL). */
  problemBaseUrl: string;
  retryBaseMs?: number;
  retryMaxMs?: number;
  /** Graceful-stop wait for running jobs; jobs still running afterwards are requeued on next boot. */
  stopTimeoutMs?: number;
  clock?: () => Date;
  random?: () => number;
}

class TimeoutError extends Error {
  override name = 'JobTimeoutError';
}

/**
 * In-process executor (PRD-API §3, §5). Push-driven: it runs when woken by an enqueue, when a job
 * finishes, and on a timer for the next run_after. It never polls on an interval, so Neon can suspend.
 */
export class JobExecutor {
  private readonly logger = new Logger(JobExecutor.name);
  private readonly handlers = new Map<string, JobHandler>();
  private readonly running = new Map<string, number>();
  private readonly inFlight = new Set<Promise<void>>();
  private readonly listeners: JobEventListener[] = [];
  private timer: NodeJS.Timeout | undefined;
  private pumping = false;
  private pumpAgain = false;
  private stopped = true;

  constructor(
    private readonly repo: JobRepository,
    signals: JobSignals,
    private readonly options: ExecutorOptions,
  ) {
    signals.onWake(() => {
      void this.pump();
    });
  }

  register<P>(handler: JobHandler<P>): void {
    if (this.handlers.has(handler.type)) throw new Error(`Job handler already registered: ${handler.type}`);
    // run() only ever receives what this handler's own parse() returned.
    this.handlers.set(handler.type, handler);
  }

  /** Subscribe to persisted job events (A9 streams them over SSE). */
  onEvent(listener: JobEventListener): void {
    this.listeners.push(listener);
  }

  /** Resume on boot: anything left `running` by a dead process goes back to the queue, then run. */
  async start(): Promise<void> {
    this.stopped = false;
    const requeued = await this.repo.requeueRunning();
    if (requeued.length > 0) this.logger.warn({ jobIds: requeued }, `Requeued ${requeued.length} job(s) interrupted by a restart`);
    await this.pump();
  }

  async stop(): Promise<void> {
    this.stopped = true;
    clearTimeout(this.timer);
    const deadline = new Promise<void>((resolve) => setTimeout(resolve, this.options.stopTimeoutMs ?? 10_000).unref());
    await Promise.race([Promise.allSettled([...this.inFlight]), deadline]);
  }

  /** Resolves once nothing is running; for tests and graceful shutdown. */
  async idle(): Promise<void> {
    while (this.inFlight.size > 0) await Promise.allSettled([...this.inFlight]);
  }

  private now(): Date {
    return this.options.clock?.() ?? new Date();
  }

  private async pump(): Promise<void> {
    if (this.stopped) return;
    if (this.pumping) {
      this.pumpAgain = true;
      return;
    }
    this.pumping = true;
    try {
      do {
        this.pumpAgain = false;
        for (;;) {
          const types = [...this.handlers.values()]
            .filter((h) => (this.running.get(h.type) ?? 0) < h.concurrency)
            .map((h) => h.type);
          const job = await this.repo.claimNext(types, this.now());
          if (!job) break;
          this.launch(job);
        }
      } while (this.wokenWhilePumping());
      await this.scheduleNext();
    } catch (error) {
      this.logger.error({ err: error instanceof Error ? error : new Error(String(error)) }, 'Job pump failed');
    } finally {
      this.pumping = false;
    }
  }

  /** Read through a method: a wake-up during an await sets the flag, which TS narrowing can't see. */
  private wokenWhilePumping(): boolean {
    return this.pumpAgain && !this.stopped;
  }

  private async scheduleNext(): Promise<void> {
    clearTimeout(this.timer);
    const types = [...this.handlers.keys()];
    const next = await this.repo.nextDue(types);
    if (!next || this.stopped) return;
    const delay = Math.max(0, Math.min(next.getTime() - this.now().getTime(), 2 ** 31 - 1));
    this.timer = setTimeout(() => void this.pump(), delay);
    this.timer.unref();
  }

  private launch(job: JobRecord): void {
    this.running.set(job.type, (this.running.get(job.type) ?? 0) + 1);
    const task = this.execute(job).finally(() => {
      this.running.set(job.type, (this.running.get(job.type) ?? 1) - 1);
      this.inFlight.delete(task);
      void this.pump();
    });
    this.inFlight.add(task);
  }

  private async execute(job: JobRecord): Promise<void> {
    const handler = this.handlers.get(job.type);
    const started = this.now().getTime();
    if (!handler) {
      await this.finishFailed(job, new NonRetryableJobError(`No handler for job type ${job.type}`), false);
      return;
    }
    const controller = new AbortController();
    let timer: NodeJS.Timeout | undefined;
    try {
      const payload = handler.parse(job.payload);
      const timeout = new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => {
          controller.abort();
          reject(new TimeoutError(`Job ${job.type} timed out after ${handler.timeoutMs} ms`));
        }, handler.timeoutMs);
      });
      const outcome = await Promise.race([
        handler.run(payload, {
          jobId: job.id,
          attempt: job.attempts,
          maxAttempts: job.maxAttempts,
          signal: controller.signal,
          progress: (stage, done, total, message) => this.progress(job.id, stage, done, total, message),
          partial: (data) => this.emit(job.id, 'partial', { jobId: job.id, ...data }),
        }),
        timeout,
      ]);
      await this.repo.succeed(job.id, outcome);
      await this.emit(job.id, 'completed', { jobId: job.id, ...outcome });
      this.logger.log({ jobId: job.id, type: job.type, attempt: job.attempts, ms: this.now().getTime() - started }, 'Job succeeded');
    } catch (error) {
      const retryable = !(error instanceof NonRetryableJobError) && job.attempts < job.maxAttempts;
      await this.finishFailed(job, error, retryable);
    } finally {
      clearTimeout(timer);
    }
  }

  private async finishFailed(job: JobRecord, error: unknown, retryable: boolean): Promise<void> {
    const message = error instanceof Error ? error.message : String(error);
    this.logger.warn({ jobId: job.id, type: job.type, attempt: job.attempts, retryable, error: message }, 'Job attempt failed');
    if (retryable) {
      const retryAt = new Date(this.now().getTime() + this.backoff(job.attempts));
      await this.repo.fail(job.id, message, retryAt);
      await this.emit(job.id, 'progress', {
        jobId: job.id,
        stage: 'queued',
        done: job.attempts,
        total: job.maxAttempts,
        message: `Retrying (attempt ${job.attempts + 1} of ${job.maxAttempts})`,
      });
      return;
    }
    await this.repo.fail(job.id, message, null);
    // The learner sees a contract problem; unknown errors stay opaque (INTERNAL).
    const { body } = toProblem(error, {
      baseUrl: this.options.problemBaseUrl,
      requestId: `job:${job.id}`,
      instance: `/v1/jobs/${job.id}`,
    });
    await this.emit(job.id, 'failed', { jobId: job.id, retryable: false, problem: body });
  }

  /** Exponential backoff with full jitter in [0.5, 1.5), capped. */
  private backoff(attempt: number): number {
    const base = this.options.retryBaseMs ?? 5_000;
    const cap = this.options.retryMaxMs ?? 5 * 60_000;
    return Math.round(Math.min(cap, base * 2 ** (attempt - 1)) * (0.5 + (this.options.random ?? Math.random)()));
  }

  private async progress(jobId: string, stage: string, done: number, total: number, message?: string): Promise<void> {
    const data = { jobId, stage, done, total, ...(message === undefined ? {} : { message }) };
    await this.repo.saveProgress(jobId, data);
    await this.emit(jobId, 'progress', data);
  }

  private async emit(jobId: string, type: JobEventType, data: unknown): Promise<void> {
    const event = await this.repo.appendEvent(jobId, type, data);
    for (const listener of this.listeners) {
      try {
        listener(event);
      } catch (error) {
        this.logger.error({ err: error instanceof Error ? error : new Error(String(error)) }, 'Job event listener failed');
      }
    }
  }
}
