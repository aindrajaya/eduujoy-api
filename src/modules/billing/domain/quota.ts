// FR-23: free tier of 1 path per month; subscriptions carry a monthly allowance; credit packs add extra paths.
// Usage is recorded in the credit ledger with reason `path`: delta 0 when the plan allowance covers it,
// delta -1 when a credit pays for it. `usedPaths` counts the delta-0 rows in the current period.
export const FREE_MONTHLY_PATHS = 1;

export type Plan = 'free' | 'subscription';

export interface Entitlement {
  plan: Plan;
  monthlyPathQuota: number;
  periodStart: Date;
  periodEnd: Date;
}

export interface Period {
  start: Date;
  end: Date;
}

export interface Quota {
  plan: Plan;
  monthlyPaths: number;
  usedPaths: number;
  credits: number;
  periodEnd: Date;
}

export function freePeriod(now: Date): Period {
  const start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
  const end = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1));
  return { start, end };
}

export function isActive(entitlement: Entitlement | null, now: Date): entitlement is Entitlement {
  return entitlement !== null && entitlement.periodStart <= now && now < entitlement.periodEnd;
}

/** The period that usage is counted in: the active entitlement's, else the free calendar month. */
export function currentPeriod(entitlement: Entitlement | null, now: Date): Period {
  return isActive(entitlement, now) ? { start: entitlement.periodStart, end: entitlement.periodEnd } : freePeriod(now);
}

export function computeQuota(input: {
  entitlement: Entitlement | null;
  creditBalance: number;
  usedPaths: number;
  now: Date;
}): Quota {
  const { entitlement, creditBalance, usedPaths, now } = input;
  const active = isActive(entitlement, now);
  return {
    plan: active ? entitlement.plan : 'free',
    monthlyPaths: active ? entitlement.monthlyPathQuota : FREE_MONTHLY_PATHS,
    usedPaths,
    credits: Math.max(0, creditBalance),
    periodEnd: currentPeriod(entitlement, now).end,
  };
}

/**
 * Which daily AI budget a learner's next path counts against (D1, 23 Oct 2026), in ReservePath's charge
 * order: a subscription's paths are paid; on the free plan the monthly allowance comes first (free),
 * then credits (paid). With nothing left the path would be refused, so it stays free.
 */
export function nextPathScope(quota: Pick<Quota, 'plan' | 'monthlyPaths' | 'usedPaths' | 'credits'>): 'free' | 'paid' {
  if (quota.plan === 'subscription') return 'paid';
  if (quota.usedPaths < quota.monthlyPaths) return 'free';
  return quota.credits > 0 ? 'paid' : 'free';
}

