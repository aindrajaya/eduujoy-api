import { Inject, Injectable } from '@nestjs/common';
import { computeQuota, currentPeriod, type Quota } from '../domain/quota';
import { BILLING_CLOCK, type Clock } from './ports/clock';
import { QUOTA_REPOSITORY, type QuotaRepository } from './ports/quota.repository';

/** Public billing query used by identity for `GET /v1/auth/me`. */
@Injectable()
export class GetQuotaQuery {
  constructor(
    @Inject(QUOTA_REPOSITORY) private readonly repo: QuotaRepository,
    @Inject(BILLING_CLOCK) private readonly clock: Clock,
  ) {}

  async execute(userId: string): Promise<Quota> {
    const now = this.clock();
    const entitlement = await this.repo.findEntitlement(userId);
    const period = currentPeriod(entitlement, now);
    const [creditBalance, usedPaths] = await Promise.all([
      this.repo.creditBalance(userId),
      this.repo.countPlanCoveredPaths(userId, period.start, period.end),
    ]);
    return computeQuota({ entitlement, creditBalance, usedPaths, now });
  }
}
