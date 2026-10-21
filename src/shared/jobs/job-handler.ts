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
  /** Parse the stored payload (Zod); a parse failure is not retried. */
  parse(payload: unknown): P;
  run(payload: P, ctx: JobContext): Promise<JobOutcome>;
}

/** Throw from a handler when retrying cannot help (bad input, permanent upstream refusal). */
export class NonRetryableJobError extends Error {
  override name = 'NonRetryableJobError';
}

export type JobEventListener = (event: JobEvent) => void;
