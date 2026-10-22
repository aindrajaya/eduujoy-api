import { computeQuota, FREE_MONTHLY_PATHS, freePeriod, nextPathScope } from './quota';

const now = new Date('2026-10-21T10:00:00Z');

describe('freePeriod', () => {
  it('is the current UTC calendar month', () => {
    expect(freePeriod(now)).toEqual({ start: new Date('2026-10-01T00:00:00Z'), end: new Date('2026-11-01T00:00:00Z') });
    expect(freePeriod(new Date('2026-12-31T23:59:59Z')).end).toEqual(new Date('2027-01-01T00:00:00Z'));
  });
});

describe('computeQuota', () => {
  it('gives the free plan 1 path per calendar month without an entitlement', () => {
    expect(computeQuota({ entitlement: null, creditBalance: 0, usedPaths: 0, now })).toEqual({
      plan: 'free',
      monthlyPaths: FREE_MONTHLY_PATHS,
      usedPaths: 0,
      credits: 0,
      periodEnd: new Date('2026-11-01T00:00:00Z'),
    });
  });

  it('uses an active entitlement for plan, allowance and period', () => {
    const entitlement = {
      plan: 'subscription' as const,
      monthlyPathQuota: 8,
      periodStart: new Date('2026-10-10T00:00:00Z'),
      periodEnd: new Date('2026-11-10T00:00:00Z'),
    };

    expect(computeQuota({ entitlement, creditBalance: 3, usedPaths: 2, now })).toEqual({
      plan: 'subscription',
      monthlyPaths: 8,
      usedPaths: 2,
      credits: 3,
      periodEnd: entitlement.periodEnd,
    });
  });

  it('falls back to the free plan once an entitlement period has ended', () => {
    const lapsed = {
      plan: 'subscription' as const,
      monthlyPathQuota: 8,
      periodStart: new Date('2026-09-01T00:00:00Z'),
      periodEnd: new Date('2026-10-01T00:00:00Z'),
    };

    expect(computeQuota({ entitlement: lapsed, creditBalance: 0, usedPaths: 0, now })).toMatchObject({
      plan: 'free',
      monthlyPaths: 1,
    });
  });

  it('never reports a negative credit balance', () => {
    expect(computeQuota({ entitlement: null, creditBalance: -2, usedPaths: 0, now }).credits).toBe(0);
  });
});

describe('nextPathScope (D1 budget scopes)', () => {
  it.each([
    ['a subscriber', { plan: 'subscription' as const, monthlyPaths: 8, usedPaths: 8, credits: 0 }, 'paid'],
    ['a free learner with the monthly path left', { plan: 'free' as const, monthlyPaths: 1, usedPaths: 0, credits: 5 }, 'free'],
    ['a free learner paying with a credit', { plan: 'free' as const, monthlyPaths: 1, usedPaths: 1, credits: 2 }, 'paid'],
    ['a free learner with nothing left', { plan: 'free' as const, monthlyPaths: 1, usedPaths: 1, credits: 0 }, 'free'],
  ])('%s → %s', (_label, quota, scope) => {
    expect(nextPathScope(quota)).toBe(scope);
  });
});

