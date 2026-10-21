// A12 billing rules (user decisions, 22 Oct 2026): one path credit per credit pack, 1–10 packs per order,
// and a subscription that includes 8 paths per month (the free tier stays at 1, see quota.ts).
import { type Entitlement } from './quota';

export type Product = 'subscription' | 'credit_pack';

export const CREDITS_PER_PACK = 1;
export const MAX_PACK_QUANTITY = 10;
export const SUBSCRIPTION_MONTHLY_PATHS = 8;

/** Credits an order grants, or null when its quantity is outside 1..MAX_PACK_QUANTITY (held for review). */
export function packCredits(quantity: number): number | null {
  if (!Number.isInteger(quantity) || quantity < 1 || quantity > MAX_PACK_QUANTITY) return null;
  return quantity * CREDITS_PER_PACK;
}

/** Lemon Squeezy subscription statuses (docs.lemonsqueezy.com, the subscription object). */
export type SubscriptionStatus = 'on_trial' | 'active' | 'paused' | 'past_due' | 'unpaid' | 'cancelled' | 'expired';

export interface SubscriptionState {
  status: SubscriptionStatus;
  /** End of the current billing cycle. */
  renewsAt: Date | null;
  /** When a cancelled or expired subscription ends or ended. */
  endsAt: Date | null;
}

/**
 * The entitlement a subscription grants right now. Trials, active and past-due (still in dunning) keep
 * the allowance until `renews_at`; a cancelled one keeps it until `ends_at` (its grace period). Paused,
 * unpaid and expired subscriptions end the plan at `now`, which drops the learner to the free tier.
 */
export function entitlementFor(sub: SubscriptionState, now: Date): Entitlement {
  const until = (end: Date | null): Entitlement => {
    const periodEnd = end && end > now ? end : now;
    return { plan: 'subscription', monthlyPathQuota: SUBSCRIPTION_MONTHLY_PATHS, periodStart: monthBefore(periodEnd), periodEnd };
  };
  switch (sub.status) {
    case 'on_trial':
    case 'active':
    case 'past_due':
      return until(sub.renewsAt);
    case 'cancelled':
      return until(sub.endsAt);
    case 'paused':
    case 'unpaid':
    case 'expired':
      return ended(now);
  }
}

/** A plan that ended at `now` (refund, expiry): quota falls back to the free tier immediately. */
export function ended(now: Date): Entitlement {
  return { plan: 'subscription', monthlyPathQuota: SUBSCRIPTION_MONTHLY_PATHS, periodStart: monthBefore(now), periodEnd: now };
}

/** One calendar month earlier, clamped to the month's last day (31 Mar → 28/29 Feb). */
export function monthBefore(date: Date): Date {
  const d = new Date(date.getTime());
  const day = d.getUTCDate();
  d.setUTCDate(1);
  d.setUTCMonth(d.getUTCMonth() - 1);
  const lastDay = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0)).getUTCDate();
  d.setUTCDate(Math.min(day, lastDay));
  return d;
}

export interface RefundInput {
  /** Credits the order granted. */
  granted: number;
  /** Cumulative refunded amount and order total, in cents (partial refunds are proportional). */
  refundedAmount: number;
  total: number;
  /** Credits already clawed back for this order by earlier refund events. */
  alreadyClawedBack: number;
  /** The learner's current credit balance. */
  balance: number;
}

export interface RefundOutcome {
  /** Credits this refund should take back in total, across all its events. */
  target: number;
  /** Ledger delta to write now (≤ 0). */
  delta: number;
  /** Credits that were already spent, so could not be taken back (logged for review). */
  shortfall: number;
}

/**
 * User decision (22 Oct 2026): claw back only unspent credits. The balance never goes negative;
 * spent credits stay spent and the shortfall is reported for review.
 */
export function refundClawback(input: RefundInput): RefundOutcome {
  const fraction = input.total > 0 ? Math.min(1, Math.max(0, input.refundedAmount / input.total)) : 1;
  const target = Math.floor(input.granted * fraction + 1e-9);
  const due = Math.max(0, target - input.alreadyClawedBack);
  const take = Math.min(due, Math.max(0, input.balance));
  return { target, delta: take === 0 ? 0 : -take, shortfall: due - take };
}
