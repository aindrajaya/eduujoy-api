import { type LlmCallEntry, type LlmCallRecorder } from './llm-call.recorder';

/**
 * Wraps a recorder for operator runs (`pnpm discovery:smoke`): keeps a running cost total and the rows of
 * the current step, counts rows that failed to record, and with `detachJobs` records `job_id` as null.
 * Operator runs execute handlers inline, outside the jobs table, and llm_calls.job_id must reference a
 * real job (A8 smoke, 22 Oct 2026: a placeholder id made every insert fail, so spend went unrecorded and
 * the budget guard, which reads llm_calls, could not see it).
 */
export class TallyingRecorder implements LlmCallRecorder {
  total = 0;
  failures = 0;
  /** Rows whose insert failed (the database dropped): retried by flushUnrecorded, never lost silently. */
  readonly unrecorded: LlmCallEntry[] = [];
  private current: LlmCallEntry[] = [];

  constructor(
    private readonly inner: LlmCallRecorder,
    private readonly options: { detachJobs?: boolean } = {},
  ) {}

  async record(entry: LlmCallEntry): Promise<void> {
    const row = this.options.detachJobs ? { ...entry, jobId: null } : entry;
    this.total += row.costUsd;
    this.current.push(row);
    try {
      await this.inner.record(row);
    } catch (error) {
      this.failures += 1;
      this.unrecorded.push(row);
      throw error;
    }
  }

  /**
   * Retries the rows that failed to record (A8 pilot, 3 Nov 2026: a dropped connection must lose no
   * metered spend). Each row is tried once per call; returns how many are still unrecorded.
   */
  async flushUnrecorded(): Promise<number> {
    for (const row of [...this.unrecorded]) {
      try {
        await this.inner.record(row);
        this.unrecorded.splice(this.unrecorded.indexOf(row), 1);
      } catch {
        // Still down: kept for the next try and for the run's report.
      }
    }
    return this.unrecorded.length;
  }

  /** The rows recorded since the last call, then starts a new step. */
  take(): LlmCallEntry[] {
    const rows = this.current;
    this.current = [];
    return rows;
  }
}
