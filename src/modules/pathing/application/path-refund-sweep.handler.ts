import { Inject, Injectable, Logger } from '@nestjs/common';
import { type EnqueueRequest, type JobHandler, JobQueue, JobRepository, type JobOutcome } from '../../../shared/jobs';
import { PATH_REFUND_SWEEP_JOB, refundSweepPayload } from './jobs';
import { PATH_REPOSITORY, type PathRepository } from './ports/path.repository';
import { RefundPathCharge } from './refund-path-charge.usecase';

/** A path left in review this long is refunded (user decision, 23 Oct 2026). */
export const REVIEW_DEADLINE_MS = 48 * 3600_000;
/**
 * A path still generating this long after its request has a job that died without its refund (or
 * vanished): longer than the 30-minute wait cap plus three attempts of up to four minutes and backoff.
 */
export const GENERATING_GRACE_MS = 2 * 3600_000;
const BATCH = 200;

export const PATH_REFUND_SWEEP_CLOCK = Symbol('PathRefundSweepClock');

const hourKey = (at: Date): string => at.toISOString().slice(0, 13);

export function refundSweepRequest(at: Date, runAfter?: Date): EnqueueRequest {
  const hour = hourKey(at);
  return { type: PATH_REFUND_SWEEP_JOB, idempotencyKey: `path-refund-sweep:${hour}`, payload: { hour }, userId: null, maxAttempts: 2, ...(runAfter ? { runAfter } : {}) };
}

/**
 * Hourly (it chains itself): refunds paths left in review past 48 hours, and finishes the refunds a
 * dead job's onDead missed: failed paths not yet refunded, and generating paths whose job is dead or
 * gone. Every refund is idempotent per path, so overlapping runs are harmless.
 */
@Injectable()
export class PathRefundSweep implements JobHandler<{ hour: string }> {
  readonly type = PATH_REFUND_SWEEP_JOB;
  readonly concurrency = 1;
  readonly timeoutMs = 120_000;
  private readonly logger = new Logger(PathRefundSweep.name);

  constructor(
    @Inject(PATH_REPOSITORY) private readonly repo: PathRepository,
    private readonly refund: RefundPathCharge,
    private readonly jobs: JobRepository,
    private readonly queue: JobQueue,
    @Inject(PATH_REFUND_SWEEP_CLOCK) private readonly clock: () => Date,
  ) {}

  parse(payload: unknown): { hour: string } {
    return refundSweepPayload.parse(payload);
  }

  async run({ hour }: { hour: string }): Promise<JobOutcome> {
    const now = this.clock();
    const result = await this.sweep(now);
    const next = new Date(Math.floor(now.getTime() / 3600_000 + 1) * 3600_000);
    await this.queue.enqueue(refundSweepRequest(next, next));
    if (result.reviewExpired + result.failed + result.stuck > 0) this.logger.log({ hour, ...result }, 'Path refund sweep');
    return { resultRef: `/pathing/refund-sweep/${hour}`, result };
  }

  async sweep(now: Date): Promise<{ reviewExpired: number; failed: number; stuck: number }> {
    let reviewExpired = 0;
    for (const path of await this.repo.reviewOverdue(new Date(now.getTime() - REVIEW_DEADLINE_MS), BATCH)) {
      if ((await this.refund.execute(path.id, 'review_expired')) === 'refunded') reviewExpired += 1;
    }
    let failed = 0;
    for (const path of await this.repo.failedUnrefunded(BATCH)) {
      if ((await this.refund.execute(path.id, 'generation_failed')) === 'refunded') failed += 1;
    }
    let stuck = 0;
    for (const path of await this.repo.generatingSince(new Date(now.getTime() - GENERATING_GRACE_MS), BATCH)) {
      const job = path.jobId ? await this.jobs.findById(path.jobId) : undefined;
      if (job && job.status !== 'dead') continue;
      await this.refund.execute(path.id, 'generation_failed', { from: 'generating' });
      stuck += 1;
    }
    return { reviewExpired, failed, stuck };
  }
}

