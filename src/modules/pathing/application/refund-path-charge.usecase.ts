import { Inject, Injectable, Logger } from '@nestjs/common';
import { UnitOfWork } from '../../../shared/events';
import { RefundPath, type RefundReason } from '../../billing/application/refund-path.usecase';
import { PATH_REPOSITORY, type PathRepository, type PathStatus } from './ports/path.repository';

/**
 * Gives back a path's charge on all four routes (A9, user decision 23 Oct 2026): the job died, its
 * resources never arrived, a reviewer rejected it, or nobody reviewed it within 48 hours. Billing first
 * (idempotent per path), then the path is marked; if the process stops in between, the hourly sweep
 * finds the path unmarked and runs this again, which billing answers with `duplicate`.
 */
@Injectable()
export class RefundPathCharge {
  private readonly logger = new Logger(RefundPathCharge.name);

  constructor(
    @Inject(PATH_REPOSITORY) private readonly repo: PathRepository,
    private readonly refunds: RefundPath,
    private readonly uow: UnitOfWork,
  ) {}

  /** `fail`: also move the path to `failed` from this status (a dead job or a rejected review). */
  async execute(pathId: string, reason: RefundReason, fail?: { from: PathStatus }): Promise<'refunded' | 'already' | 'not_charged' | 'missing'> {
    const path = await this.repo.findById(pathId);
    if (!path) return 'missing';
    const outcome = await this.refunds.execute(path.userId, path.id, reason);
    await this.uow.run(async (tx) => {
      if (fail) await this.repo.setStatus(tx, path.id, fail.from, 'failed');
      if (outcome !== 'not_charged') await this.repo.markRefunded(tx, path.id);
    });
    if (outcome === 'not_charged') this.logger.warn({ pathId, reason }, 'Path had no charge to refund');
    return outcome === 'refunded' ? 'refunded' : outcome === 'duplicate' ? 'already' : 'not_charged';
  }
}
