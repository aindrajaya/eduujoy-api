import { type Tx } from '../../../../shared/db';
import { type Entitlement } from '../../domain/quota';

export const BILLING_REPOSITORY = Symbol('BillingRepository');

export interface StoredBillingEvent {
  id: string;
  type: string;
  payload: unknown;
  processedAt: Date | null;
}

/** What the quota decision sees under the learner's lock. */
export interface LockedQuotaState {
  entitlement: Entitlement | null;
  balance: number;
  /** Plan-covered paths (ledger reason `path`, delta 0) in [from, to), not counting refunded ones. */
  usedPathsBetween(from: Date, to: Date): Promise<number>;
}

export type PathCharge = 'plan' | 'credit' | 'exceeded';

/**
 * Billing persistence. Every ledger change for a learner runs in one transaction under a per-learner
 * advisory lock, so balances can't be raced; unique keys make every provider effect apply once.
 */
export interface BillingRepository {
  /** Stores a webhook once per `providerEventId`; null when it was already stored (a replay). */
  recordEvent(tx: Tx, event: { providerEventId: string; type: string; payload: unknown }): Promise<string | null>;
  findEvent(id: string): Promise<StoredBillingEvent | null>;
  markProcessed(id: string, outcome: string): Promise<void>;
  /** Purchase credits, once per order (`credit_ledger` unique (reason, external_ref)). */
  grantPurchase(input: { userId: string; credits: number; orderRef: string }): Promise<'granted' | 'duplicate' | 'unknown_user'>;
  findPurchase(orderRef: string): Promise<{ userId: string; credits: number } | null>;
  /** Runs `decide` with the balance and earlier claw-backs for the order, then writes its delta once per target. */
  applyRefund(
    input: { userId: string; orderRef: string },
    decide: (state: { balance: number; alreadyClawedBack: number }) => { target: number; delta: number },
  ): Promise<'applied' | 'duplicate'>;
  /**
   * Applies a subscription state. For the stored subscription, only events newer in provider time apply
   * (`stale` otherwise). Another subscription of the same learner replaces the stored one only when it
   * grants more (a later period end) or the stored one has already ended (`other_subscription` otherwise),
   * so an event for a second, lapsed subscription can never drop a paying learner to free.
   */
  upsertSubscription(input: {
    userId: string;
    subscriptionId: string;
    orderId: string;
    entitlement: Entitlement;
    providerUpdatedAt: Date;
    now: Date;
  }): Promise<'applied' | 'stale' | 'other_subscription' | 'unknown_user'>;
  /** Ends the stored subscription now if it is this one (refunds); returns its learner, else null. */
  endSubscription(subscriptionId: string, entitlement: Entitlement): Promise<string | null>;
  /** Ends the stored subscription now if this order started it (refunded first order); else null. */
  endSubscriptionForOrder(orderId: string, entitlement: Entitlement): Promise<string | null>;
  /**
   * Charges one path once per `pathRef`: `decide` picks plan allowance, a credit or exceeded under the
   * learner's lock; the ledger row is written in the same transaction. A repeated `pathRef` returns the
   * earlier charge.
   */
  reservePath(input: { userId: string; pathRef: string }, decide: (state: LockedQuotaState) => Promise<PathCharge>): Promise<PathCharge>;
  /**
   * Gives back one path's charge once (a `refund` row keyed like the charge): a credit returns +1, a
   * plan charge frees its allowance slot. `not_charged` when the path was never charged.
   */
  refundPath(input: { userId: string; pathRef: string }): Promise<'refunded' | 'duplicate' | 'not_charged'>;
}
