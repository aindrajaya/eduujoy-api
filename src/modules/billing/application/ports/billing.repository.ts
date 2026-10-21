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
  /** Plan-covered paths (ledger reason `path`, delta 0) in [from, to). */
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
  /** Applies a subscription state unless an event with a newer provider `updated_at` already did. */
  upsertSubscription(input: {
    userId: string;
    subscriptionId: string;
    entitlement: Entitlement;
    providerUpdatedAt: Date;
  }): Promise<'applied' | 'stale' | 'unknown_user'>;
  /** Ends a subscription's entitlement now (refunds); returns its learner, or null when unknown. */
  endSubscription(subscriptionId: string, entitlement: Entitlement): Promise<string | null>;
  /** The learner's subscription id, if any (subscription orders refunded from the order event). */
  subscriptionOf(userId: string): Promise<string | null>;
  /**
   * Charges one path once per `pathRef`: `decide` picks plan allowance, a credit or exceeded under the
   * learner's lock; the ledger row is written in the same transaction. A repeated `pathRef` returns the
   * earlier charge.
   */
  reservePath(input: { userId: string; pathRef: string }, decide: (state: LockedQuotaState) => Promise<PathCharge>): Promise<PathCharge>;
}
