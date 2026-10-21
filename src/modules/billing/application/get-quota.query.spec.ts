import { type Entitlement } from '../domain/quota';
import { GetQuotaQuery } from './get-quota.query';
import { type QuotaRepository } from './ports/quota.repository';

describe('GetQuotaQuery', () => {
  const now = new Date('2026-10-21T10:00:00Z');

  function repo(entitlement: Entitlement | null): QuotaRepository & { countPlanCoveredPaths: jest.Mock } {
    return {
      findEntitlement: jest.fn().mockResolvedValue(entitlement),
      creditBalance: jest.fn().mockResolvedValue(2),
      countPlanCoveredPaths: jest.fn().mockResolvedValue(1),
    };
  }

  it('counts usage in the free calendar month when there is no entitlement', async () => {
    const fake = repo(null);

    const quota = await new GetQuotaQuery(fake, () => now).execute('user-1');

    expect(fake.countPlanCoveredPaths).toHaveBeenCalledWith(
      'user-1',
      new Date('2026-10-01T00:00:00Z'),
      new Date('2026-11-01T00:00:00Z'),
    );
    expect(quota).toEqual({ plan: 'free', monthlyPaths: 1, usedPaths: 1, credits: 2, periodEnd: new Date('2026-11-01T00:00:00Z') });
  });

  it('counts usage in the entitlement period when one is active', async () => {
    const entitlement: Entitlement = {
      plan: 'subscription',
      monthlyPathQuota: 8,
      periodStart: new Date('2026-10-10T00:00:00Z'),
      periodEnd: new Date('2026-11-10T00:00:00Z'),
    };
    const fake = repo(entitlement);

    await new GetQuotaQuery(fake, () => now).execute('user-1');

    expect(fake.countPlanCoveredPaths).toHaveBeenCalledWith('user-1', entitlement.periodStart, entitlement.periodEnd);
  });
});
