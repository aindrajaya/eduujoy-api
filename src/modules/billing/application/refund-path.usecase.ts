import { Inject, Injectable, Logger } from '@nestjs/common';
import { BILLING_REPOSITORY, type BillingRepository } from './ports/billing.repository';

export type RefundReason = 'generation_failed' | 'review_rejected' | 'review_expired' | 'wait_expired';

/**
 * Gives back a path's charge (A9, user decision 23 Oct 2026): generation failed for good, a reviewer
 * rejected the path, nobody reviewed it within 48 hours, or its resources never arrived. Idempotent
 * per path, so every refund route may call it again.
 */
@Injectable()
export class RefundPath {
  private readonly logger = new Logger(RefundPath.name);

  constructor(@Inject(BILLING_REPOSITORY) private readonly repo: BillingRepository) {}

  async execute(userId: string, pathRef: string, reason: RefundReason): Promise<'refunded' | 'duplicate' | 'not_charged'> {
    const outcome = await this.repo.refundPath({ userId, pathRef });
    if (outcome === 'refunded') this.logger.log({ userId, pathRef, reason }, 'Path charge refunded');
    return outcome;
  }
}
