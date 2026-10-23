import { Logger } from '@nestjs/common';
import { toProblem } from '../common/problem/problem';
import { type JobSignals } from './job-queue';
import { type JobEventListener, type JobHandler, JobWaitExpiredError, NonRetryableJobError, RescheduleJob } from './job-handler';
import { type JobRepository } from './job.repository';
import { type JobEventType, type JobRecord } from './job.types';

export interface ExecutorOptions {
  /** Base URL for problem `type` links in failed events (API_PUBLIC_URL). */
  problemBaseUrl: string;
  retryBaseMs?: number;
  retryMaxMs?: number;
  /** Graceful-stop wait for running jobs; this instance's unfinished jobs are requeued afterwards. */
  stopTimeoutMs?: number;
  /**
   * A `running` job is stale (its process is gone) once its lock is older than the longest handler
   * timeout plus this margin. Recent locks may belong to an overlapping deploy and are left alone.
   */
  staleGraceMs?: number;
  /**
   * After a timeout aborts a run, wait up to this long for it to settle before recording the failure
   * and scheduling the retry, so a run and its retry don't overlap.
   */
  abortGraceMs?: number;
  /** Finished jobs (and their events) are pruned after this long; checked on start and daily. */
  retentionMs?: number;
  clock?: () => Date;
  random?: () => number;
}

/** JobHandler.maxWaitMs default (A9: a path waits at most 30 minutes for its resources). */
const DEFAULT_MAX_WAIT_MS = 30 * 60_000;

/** Timer floor for a job that is already due but was not claimed (scheduleNext). */
const DUE_RECHECK_MS = 250;

class TimeoutError extends Error {
  override name = 'JobTimeoutError';
}

interface Claim {
  id: string;
  lockedAt: Date;
}

/**
 * In-process executor (PRD-API §3, §5). Push-driven: it runs when woken by an enqueue, when a job
 * finishes, and on timers for the next future run_after and the next stale lock. It never polls on an
 * interval, so Neon can suspend. Every write a run makes is conditional on the run still holding its
 * lock, so a zombie or overlapping instance can never overwrite a job another instance took over.
 */
export class JobExecutor {
  private readonly logger = new Logger(JobExecutor.name);
  private readonly handlers = new Map<string, JobHandler>();
  private readonly running = new Map<string, number>();
  private readonly inFlight = new Map<Promise<void>, Claim>();
  private readonly listeners: JobEventListener[] = [];
  private timer: NodeJS.Timeout | undefined;
  private staleTimer: NodeJS.Timeout | undefined;
  private pruneTimer: NodeJS.Timeout | undefined;
  private pumping = false;
  /** The pump in progress, so stop() can wait for its queries instead of racing the pool shutdown. */
  private pumpTask: Promise<void> = Promise.resolve();
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

  /** Subscribe to persisted job events (A9 streams them over SSE); returns the unsubscribe. */
  onEvent(listener: JobEventListener): () => void {
    this.listeners.push(listener);
    return () => {
      const i = this.listeners.indexOf(listener);
      if (i >= 0) this.listeners.splice(i, 1);
    };
  }

  /** Resume on boot: requeue jobs whose process is gone (stale locks), then run. */
  async start(): Promise<void> {
    this.stopped = false;
    await this.recoverStale();
    await this.prune();
    this.pruneTimer = setInterval(() => void this.prune(), 24 * 60 * 60 * 1000);
    this.pruneTimer.unref();
    await this.pump();
  }

  /** Best effort: a failed prune is logged and retried on the next daily tick. */
  private async prune(): Promise<void> {
    try {
      const pruned = await this.repo.pruneFinished(this.options.retentionMs ?? 30 * 24 * 60 * 60 * 1000);
      if (pruned > 0) this.logger.log({ pruned }, `Pruned ${pruned} finished job(s) and their events`);
    } catch (error) {
      this.logger.error({ err: error instanceof Error ? error : new Error(String(error)) }, 'Job prune failed');
    }
  }

  /**
   * Waits for running jobs (up to stopTimeoutMs), then puts this instance's unfinished jobs back in the
   * queue so the next instance can pick them up at once instead of waiting for them to go stale.
   */
  async stop(): Promise<void> {
    this.stopped = true;
    clearTimeout(this.timer);
    clearTimeout(this.staleTimer);
    clearInterval(this.pruneTimer);
    const deadline = new Promise<void>((resolve) => setTimeout(resolve, this.options.stopTimeoutMs ?? 10_000).unref());
    // A pump mid-query must finish (and release anything it claims after stopping) before the pool closes.
    await Promise.race([this.pumpTask, deadline]);
    await Promise.race([Promise.allSettled([...this.inFlight.keys()]), deadline]);
    const unfinished = [...this.inFlight.values()];
    if (unfinished.length === 0) return;
    const released = await this.repo.release(unfinished);
    if (released.length > 0) this.logger.warn({ jobIds: released }, `Released ${released.length} unfinished job(s) on shutdown`);
  }

  /** Resolves once nothing is running; for tests and graceful shutdown. */
  async idle(): Promise<void> {
    while (this.inFlight.size > 0) await Promise.allSettled([...this.inFlight.keys()]);
  }

  private now(): Date {
    return this.options.clock?.() ?? new Date();
  }

  private staleAfterMs(): number {
    const longest = Math.max(0, ...[...this.handlers.values()].map((h) => h.timeoutMs));
    return longest + (this.options.staleGraceMs ?? 60_000);
  }

  /** Requeues stale running jobs and arms a timer for when the oldest remaining lock goes stale. */
  private async recoverStale(): Promise<void> {
    clearTimeout(this.staleTimer);
    const staleAfter = this.staleAfterMs();
    const requeued = await this.repo.requeueStale(staleAfter);
    if (requeued.length > 0) this.logger.warn({ jobIds: requeued }, `Requeued ${requeued.length} job(s) left running by a stopped process`);
    const untilStale = await this.repo.msUntilNextStale(staleAfter);
    if (untilStale === null || this.stopped) return;
    const delay = Math.max(1_000, untilStale + 1);
    this.staleTimer = setTimeout(() => {
      void this.recoverStale().then(() => this.pump());
    }, Math.min(delay, 2 ** 31 - 1));
    this.staleTimer.unref();
  }

  private async pump(): Promise<void> {
    if (this.stopped) return;
    if (this.pumping) {
      this.pumpAgain = true;
      return;
    }
    this.pumping = true;
    this.pumpTask = this.pumpLoop();
    await this.pumpTask;
  }

  private async pumpLoop(): Promise<void> {
    try {
      // scheduleNext runs inside the loop: a wake-up that lands while it queries must pump again,
      // because due-now jobs get no timer.
      do {
        this.pumpAgain = false;
        for (;;) {
          const job = await this.repo.claimNext(this.typesWithFreeSlots());
          if (!job) break;
          if (this.stopped) {
            // Claimed while stop() ran: hand it straight back rather than start work during shutdown.
            if (job.lockedAt) await this.repo.release([{ id: job.id, lockedAt: job.lockedAt }]);
            return;
          }
          this.launch(job);
        }
        if (this.stopped) return;
        await this.scheduleNext();
      } while (this.wokenWhilePumping());
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

  private typesWithFreeSlots(): string[] {
    return [...this.handlers.values()].filter((h) => (this.running.get(h.type) ?? 0) < h.concurrency).map((h) => h.type);
  }

  /**
   * Arms one timer for the earliest run_after among types with a free slot. Saturated types need no
   * timer (a finishing job pumps). A job already due (it fell due after the claim missed it, or
   * another instance holds its row) is retried after DUE_RECHECK_MS, so this can't spin.
   */
  private async scheduleNext(): Promise<void> {
    clearTimeout(this.timer);
    const untilDue = await this.repo.msUntilNextDue(this.typesWithFreeSlots());
    if (untilDue === null || this.stopped) return;
    const delay = untilDue <= 0 ? DUE_RECHECK_MS : Math.min(Math.ceil(untilDue), 2 ** 31 - 1);
    this.timer = setTimeout(() => void this.pump(), delay);
    this.timer.unref();
  }

  private launch(job: JobRecord): void {
    if (!job.lockedAt) throw new Error(`Claimed job ${job.id} has no lock`);
    const claim = { id: job.id, lockedAt: job.lockedAt };
    this.running.set(job.type, (this.running.get(job.type) ?? 0) + 1);
    const task = this.execute(job, claim).finally(() => {
      this.running.set(job.type, (this.running.get(job.type) ?? 1) - 1);
      this.inFlight.delete(task);
      void this.pump();
    });
    this.inFlight.set(task, claim);
  }

  private async execute(job: JobRecord, claim: Claim): Promise<void> {
    const handler = this.handlers.get(job.type);
    const started = this.now().getTime();
    if (!handler) {
      await this.finishFailed(job, claim, new NonRetryableJobError(`No handler for job type ${job.type}`), false);
      return;
    }
    const controller = new AbortController();
    let timer: NodeJS.Timeout | undefined;
    let run: Promise<unknown> | undefined;
    try {
      const payload = handler.parse(job.payload);
      const timeout = new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => {
          controller.abort();
          reject(new TimeoutError(`Job ${job.type} timed out after ${handler.timeoutMs} ms`));
        }, handler.timeoutMs);
      });
      const running = handler.run(payload, {
        jobId: job.id,
        attempt: job.attempts,
        maxAttempts: job.maxAttempts,
        signal: controller.signal,
        progress: (stage, done, total, message) => this.progress(job.id, stage, done, total, message),
        partial: (data) => this.emit(job.id, 'partial', { jobId: job.id, ...data }),
      });
      run = running;
      const outcome = await Promise.race([running, timeout]);
      if (!(await this.repo.succeed(claim, outcome))) {
        this.logger.warn({ jobId: job.id }, 'Job finished after another instance took it over; result dropped');
        return;
      }
      await this.emit(job.id, 'completed', { jobId: job.id, ...outcome });
      this.logger.log({ jobId: job.id, type: job.type, attempt: job.attempts, ms: this.now().getTime() - started }, 'Job succeeded');
    } catch (error) {
      if (error instanceof RescheduleJob) {
        await this.reschedule(job, claim, handler, error);
        return;
      }
      if (error instanceof TimeoutError && run) await this.settleOrGrace(job.id, run);
      const retryable = !(error instanceof NonRetryableJobError) && job.attempts < job.maxAttempts;
      await this.finishFailed(job, claim, error, retryable);
    } finally {
      clearTimeout(timer);
    }
  }

  /** RescheduleJob: wait without using an attempt, or fail for good once past the handler's maxWaitMs. */
  private async reschedule(job: JobRecord, claim: Claim, handler: JobHandler, request: RescheduleJob): Promise<void> {
    const maxWaitMs = handler.maxWaitMs ?? DEFAULT_MAX_WAIT_MS;
    if (await this.repo.reschedule(claim, Math.max(0, request.delayMs), maxWaitMs)) {
      this.logger.log({ jobId: job.id, type: job.type, delayMs: request.delayMs, reason: request.message }, 'Job rescheduled');
      return;
    }
    await this.finishFailed(job, claim, new JobWaitExpiredError(`Gave up waiting after ${maxWaitMs} ms: ${request.message}`), false);
  }

  /** Waits for an aborted run to settle, at most abortGraceMs; its late outcome is ignored either way. */
  private async settleOrGrace(jobId: string, run: Promise<unknown>): Promise<void> {
    let grace: NodeJS.Timeout | undefined;
    const settled = await Promise.race([
      run.then(
        () => true,
        () => true,
      ),
      new Promise<false>((resolve) => {
        grace = setTimeout(() => {
          resolve(false);
        }, this.options.abortGraceMs ?? 10_000);
      }),
    ]);
    clearTimeout(grace);
    if (!settled) this.logger.warn({ jobId }, 'Timed-out job ignored its abort signal; scheduling the retry anyway');
  }

  private async finishFailed(job: JobRecord, claim: Claim, error: unknown, retryable: boolean): Promise<void> {
    const message = error instanceof Error ? error.message : String(error);
    this.logger.warn({ jobId: job.id, type: job.type, attempt: job.attempts, retryable, error: message }, 'Job attempt failed');
    if (retryable) {
      if (!(await this.repo.fail(claim, message, this.backoff(job.attempts)))) return;
      await this.emit(job.id, 'progress', {
        jobId: job.id,
        stage: 'queued',
        done: job.attempts,
        total: job.maxAttempts,
        message: `Retrying (attempt ${job.attempts + 1} of ${job.maxAttempts})`,
      });
      return;
    }
    if (!(await this.repo.fail(claim, message, null))) return;
    // The learner sees a contract problem; unknown errors stay opaque (INTERNAL).
    const { body } = toProblem(error, {
      baseUrl: this.options.problemBaseUrl,
      requestId: `job:${job.id}`,
      instance: `/v1/jobs/${job.id}`,
    });
    await this.emit(job.id, 'failed', { jobId: job.id, retryable: false, problem: body });
    await this.notifyDead(job, error);
  }

  /** JobHandler.onDead, best effort; skipped when the payload itself is unparseable. */
  private async notifyDead(job: JobRecord, error: unknown): Promise<void> {
    const handler = this.handlers.get(job.type);
    if (!handler?.onDead) return;
    try {
      await handler.onDead(handler.parse(job.payload), { jobId: job.id, error });
    } catch (hookError) {
      this.logger.error({ jobId: job.id, type: job.type, err: hookError instanceof Error ? hookError : new Error(String(hookError)) }, 'Job onDead hook failed');
    }
  }

  /** Exponential backoff, capped, with ±50% jitter (factor in [0.5, 1.5)). */
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
