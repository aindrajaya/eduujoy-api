import { Inject, Injectable, Logger } from '@nestjs/common';
import { type ReviewResolved } from '../../../shared/common/review';
import { type EventBus } from '../../../shared/events';
import { PATH_REPOSITORY, type PathRepository } from './ports/path.repository';
import { RefundPathCharge } from './refund-path-charge.usecase';

/**
 * A reviewer rejected a path (A13 publishes ReviewResolved): refund it and mark it failed, whether it
 * was held in review or flagged while active. Approvals change nothing here: an approved path in review
 * needs a reviewer's edited steps, which A13 defines.
 */
@Injectable()
export class RefundRejectedPaths {
  private readonly logger = new Logger(RefundRejectedPaths.name);

  constructor(
    @Inject(PATH_REPOSITORY) private readonly repo: PathRepository,
    private readonly refund: RefundPathCharge,
  ) {}

  listen(bus: EventBus): void {
    bus.on<ReviewResolved>('ReviewResolved', (e) => this.onResolved(e));
  }

  async onResolved(e: ReviewResolved): Promise<void> {
    if (e.kind !== 'path' || e.resolution !== 'rejected') return;
    const path = await this.repo.findById(e.targetId);
    if (!path) return;
    const from = path.status === 'under_review' || path.status === 'active' ? { from: path.status } : undefined;
    const outcome = await this.refund.execute(path.id, 'review_rejected', from);
    this.logger.log({ pathId: path.id, reviewItemId: e.reviewItemId, outcome }, 'Rejected path refunded');
  }
}
