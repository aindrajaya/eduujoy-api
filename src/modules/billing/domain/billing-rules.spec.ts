import {
  CREDITS_PER_PACK,
  entitlementFor,
  MAX_PACK_QUANTITY,
  monthBefore,
  packCredits,
  refundClawback,
  SUBSCRIPTION_MONTHLY_PATHS,
} from './billing-rules';
import { computeQuota } from './quota';

const NOW = new Date('2026-10-22T12:00:00Z');
const NEXT = new Date('2026-11-22T12:00:00Z');

describe('packCredits', () => {
  it('grants one credit per pack for 1 to 10 packs', () => {
    expect([CREDITS_PER_PACK, MAX_PACK_QUANTITY, SUBSCRIPTION_MONTHLY_PATHS]).toEqual([1, 10, 8]);
    expect(packCredits(1)).toBe(1);
    expect(packCredits(10)).toBe(10);
  });

  it('refuses quantities outside 1 to 10', () => {
    for (const q of [0, -1, 11, 2.5, Number.NaN]) expect(packCredits(q)).toBeNull();
  });
});

describe('entitlementFor', () => {
  it('keeps 8 paths until renews_at for trials, active and past-due subscriptions', () => {
    for (const status of ['on_trial', 'active', 'past_due'] as const) {
      const e = entitlementFor({ status, renewsAt: NEXT, endsAt: null }, NOW);
      expect(e).toEqual({ plan: 'subscription', monthlyPathQuota: 8, periodStart: new Date('2026-10-22T12:00:00Z'), periodEnd: NEXT });
      expect(computeQuota({ entitlement: e, creditBalance: 0, usedPaths: 0, now: NOW })).toMatchObject({ plan: 'subscription', monthlyPaths: 8 });
    }
  });

  it('keeps a cancelled subscription until ends_at (grace period)', () => {
    const endsAt = new Date('2026-11-01T00:00:00Z');
    expect(entitlementFor({ status: 'cancelled', renewsAt: NEXT, endsAt }, NOW).periodEnd).toEqual(endsAt);
  });

  it('drops paused, unpaid and expired subscriptions to the free tier at once', () => {
    for (const status of ['paused', 'unpaid', 'expired'] as const) {
      const e = entitlementFor({ status, renewsAt: NEXT, endsAt: NEXT }, NOW);
      expect(computeQuota({ entitlement: e, creditBalance: 0, usedPaths: 0, now: NOW })).toMatchObject({ plan: 'free', monthlyPaths: 1 });
    }
  });

  it('starts the period no later than now when the cycle ends more than a month out (long trials)', () => {
    const e = entitlementFor({ status: 'on_trial', renewsAt: new Date('2027-02-01T00:00:00Z'), endsAt: null }, NOW);
    expect(e.periodStart).toEqual(NOW);
    expect(computeQuota({ entitlement: e, creditBalance: 0, usedPaths: 0, now: NOW }).plan).toBe('subscription');
  });

  it('treats an end date already in the past as ended now', () => {
    const e = entitlementFor({ status: 'active', renewsAt: new Date('2026-10-01T00:00:00Z'), endsAt: null }, NOW);
    expect(computeQuota({ entitlement: e, creditBalance: 0, usedPaths: 0, now: NOW }).plan).toBe('free');
  });
});

describe('monthBefore', () => {
  it('steps back one calendar month and clamps to the last day', () => {
    expect(monthBefore(new Date('2026-11-22T12:00:00Z')).toISOString()).toBe('2026-10-22T12:00:00.000Z');
    expect(monthBefore(new Date('2027-03-31T00:00:00Z')).toISOString()).toBe('2027-02-28T00:00:00.000Z');
    expect(monthBefore(new Date('2027-01-15T00:00:00Z')).toISOString()).toBe('2026-12-15T00:00:00.000Z');
  });
});

describe('refundClawback', () => {
  it('takes back every refunded credit that is still unspent', () => {
    expect(refundClawback({ granted: 3, refundedAmount: 600, total: 600, alreadyClawedBack: 0, balance: 5 })).toEqual({ target: 3, delta: -3, shortfall: 0 });
  });

  it('never makes the balance negative, and reports the spent credits', () => {
    expect(refundClawback({ granted: 3, refundedAmount: 600, total: 600, alreadyClawedBack: 0, balance: 1 })).toEqual({ target: 3, delta: -1, shortfall: 2 });
    expect(refundClawback({ granted: 2, refundedAmount: 400, total: 400, alreadyClawedBack: 0, balance: 0 })).toEqual({ target: 2, delta: 0, shortfall: 2 });
  });

  it('is proportional for partial refunds and cumulative across refund events', () => {
    const first = refundClawback({ granted: 4, refundedAmount: 400, total: 800, alreadyClawedBack: 0, balance: 4 });
    expect(first).toEqual({ target: 2, delta: -2, shortfall: 0 });
    expect(refundClawback({ granted: 4, refundedAmount: 800, total: 800, alreadyClawedBack: 2, balance: 2 })).toEqual({ target: 4, delta: -2, shortfall: 0 });
    // A replay of the first event takes nothing more.
    expect(refundClawback({ granted: 4, refundedAmount: 400, total: 800, alreadyClawedBack: 2, balance: 2 })).toEqual({ target: 2, delta: 0, shortfall: 0 });
  });
});
