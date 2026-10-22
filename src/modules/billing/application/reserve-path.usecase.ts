import { Inject, Injectable } from '@nestjs/common';
import { computeQuota, currentPeriod } from '../domain/quota';
import { QuotaExceededError } from './errors';
import { BILLING_REPOSITORY, type BillingRepository } from './ports/billing.repository';

/**
 * Charges one generated path (FR-23): the plan allowance first, then a credit. Pathing (A9) calls this
 * before enqueueing `generate-path`; once both are used up it throws QuotaExceededError (402). The
 * charge is idempotent per `pathRef`, so a retried request never charges twice.
 */
@Injectable()
export class ReservePath {
  constructor(@Inject(BILLING_REPOSITORY) private readonly repo: BillingRepository) {}

  async execute(userId: string, pathRef: string): Promise<'plan' | 'credit'> {
    let limit = { monthlyPaths: 0, periodEnd: new Date() };
    const charge = await this.repo.reservePath({ userId, pathRef }, async (state) => {
      const now = new Date();
      const period = currentPeriod(state.entitlement, now);
      const usedPaths = await state.usedPathsBetween(period.start, period.end);
      const quota = computeQuota({ entitlement: state.entitlement, creditBalance: state.balance, usedPaths, now });
      limit = { monthlyPaths: quota.monthlyPaths, periodEnd: quota.periodEnd };
      if (usedPaths < quota.monthlyPaths) return 'plan';
      return quota.credits > 0 ? 'credit' : 'exceeded';
    });
    if (charge === 'exceeded') throw new QuotaExceededError(limit.monthlyPaths, limit.periodEnd);
    return charge;
  }
}
