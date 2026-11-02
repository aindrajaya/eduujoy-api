import { ProblemException } from '../common/problem/problem';
import { type JobEvent } from './job.types';

/** Pipeline stages a job reports (contract JobProgressEvent.stage). */
export type JobStage = 'queued' | 'discover' | 'analyse' | 'design' | 'validate' | 'grade' | 'reassess';

export interface JobContext {
  jobId: string;
  /** 1 on the first try. */
  attempt: number;
  maxAttempts: number;
  /**
   * Aborted when the handler's timeout passes. run() MUST stop when it aborts: pass it to every fetch
   * and SDK call and check `signal.aborted` between steps. The retry waits for the aborted run to
   * settle (or a grace period), but a run that ignores the signal still holds a slot until it does.
   */
  signal: AbortSignal;
  progress(stage: JobStage, done: number, total: number, message?: string): Promise<void>;
  /** Early results, e.g. the first SOP step before the rest (contract JobPartialEvent). */
  partial(data: { kind: 'path_step' | 'checkpoint_item' } & Record<string, unknown>): Promise<void>;
}

/** What a successful job leaves behind: where its result lives (contract JobCompletedEvent). */
export interface JobOutcome {
  resultRef: string;
  result?: unknown;
}

/**
 * One handler per job type (PRD-API §5 jobs table). Handlers must be idempotent and must stop when
 * `ctx.signal` aborts (see JobContext.signal).
 */
export interface JobHandler<P = unknown> {
  type: string;
  concurrency: number;
  timeoutMs: number;
  /**
   * How long a job may keep rescheduling itself (RescheduleJob), counted from when it was enqueued.
   * Past it the job fails permanently (JobWaitExpiredError). Default 30 minutes (A9).
   */
  maxWaitMs?: number;
  /** Parse the stored payload (Zod); a parse failure is not retried. */
  parse(payload: unknown): P;
  run(payload: P, ctx: JobContext): Promise<JobOutcome>;
  /**
   * Called once the job is `dead` (attempts exhausted, a non-retryable error or the wait cap), after
   * its `failed` event, e.g. to refund a charge. Best effort: a throw is logged, not retried, and it
   * is not called if the process stops in between, so what it does must be idempotent and must also
   * be reachable from a reconciling sweep.
   */
  onDead?(payload: P, info: { jobId: string; error: unknown }): Promise<void>;
}

/** Throw from a handler when retrying cannot help (bad input, permanent upstream refusal). */
export class NonRetryableJobError extends Error {
  override name = 'NonRetryableJobError';
}

export type JobEventListener = (event: JobEvent) => void;

/**
 * Throw from a handler when the job can't proceed yet, e.g. its resources are still being discovered.
 * The job goes back in the queue and runs again after `delayMs` (or sooner, when woken through
 * JobQueue.wakeWaiting). It uses no attempt and holds no slot while it waits; see JobHandler.maxWaitMs.
 */
export class RescheduleJob extends Error {
  override name = 'RescheduleJob';

  constructor(
    readonly delayMs: number,
    reason: string,
  ) {
    super(reason);
  }
}

/**
 * A rescheduled job passed its handler's maxWaitMs. The learner sees SERVICE_UNAVAILABLE with a fixed
 * detail; the internal reason stays in `message` (stored in jobs.error, never sent).
 */
export class JobWaitExpiredError extends ProblemException {
  constructor(reason: string) {
    super(503, 'SERVICE_UNAVAILABLE', 'This is taking longer than expected', { detail: 'Please try again later.' });
    this.message = reason;
  }
}
