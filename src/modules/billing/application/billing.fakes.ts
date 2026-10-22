import { randomUUID } from 'node:crypto';
import { type Entitlement } from '../domain/quota';
import { type BillingProvider } from './ports/billing-provider';
import { type BillingRepository, type LockedQuotaState, type PathCharge, type StoredBillingEvent } from './ports/billing.repository';

interface LedgerRow {
  userId: string;
  delta: number;
  reason: 'purchase' | 'path' | 'refund';
  externalRef: string | null;
  createdAt: Date;
}

/** In-memory BillingRepository with the same uniqueness rules as the tables. */
export class FakeBillingRepository implements BillingRepository {
  readonly users = new Set<string>();
  readonly events = new Map<string, StoredBillingEvent & { providerEventId: string; outcome: string | null }>();
  readonly ledger: LedgerRow[] = [];
  readonly entitlements = new Map<string, Entitlement & { subscriptionId: string | null; orderId: string | null; providerUpdatedAt: Date | null }>();

  recordEvent(_tx: never, event: { providerEventId: string; type: string; payload: unknown }): Promise<string | null> {
    if ([...this.events.values()].some((e) => e.providerEventId === event.providerEventId)) return Promise.resolve(null);
    const id = randomUUID();
    this.events.set(id, { id, ...event, processedAt: null, outcome: null });
    return Promise.resolve(id);
  }

  findEvent(id: string): Promise<StoredBillingEvent | null> {
    return Promise.resolve(this.events.get(id) ?? null);
  }

  markProcessed(id: string, outcome: string): Promise<void> {
    const e = this.events.get(id);
    if (e && !e.processedAt) Object.assign(e, { processedAt: new Date(), outcome });
    return Promise.resolve();
  }

  balance(userId: string): number {
    return this.ledger.filter((r) => r.userId === userId).reduce((s, r) => s + r.delta, 0);
  }

  private insert(row: Omit<LedgerRow, 'createdAt'>): boolean {
    if (row.externalRef && this.ledger.some((r) => r.reason === row.reason && r.externalRef === row.externalRef)) return false;
    this.ledger.push({ ...row, createdAt: new Date() });
    return true;
  }

  grantPurchase(input: { userId: string; credits: number; orderRef: string }): Promise<'granted' | 'duplicate' | 'unknown_user'> {
    if (!this.users.has(input.userId)) return Promise.resolve('unknown_user');
    return Promise.resolve(this.insert({ userId: input.userId, delta: input.credits, reason: 'purchase', externalRef: input.orderRef }) ? 'granted' : 'duplicate');
  }

  findPurchase(orderRef: string): Promise<{ userId: string; credits: number } | null> {
    const row = this.ledger.find((r) => r.reason === 'purchase' && r.externalRef === orderRef);
    return Promise.resolve(row ? { userId: row.userId, credits: row.delta } : null);
  }

  applyRefund(
    input: { userId: string; orderRef: string },
    decide: (state: { balance: number; alreadyClawedBack: number }) => { target: number; delta: number },
  ): Promise<'applied' | 'duplicate'> {
    const alreadyClawedBack = -this.ledger.filter((r) => r.reason === 'refund' && r.externalRef?.startsWith(`${input.orderRef}:refund:`)).reduce((s, r) => s + r.delta, 0);
    const { target, delta } = decide({ balance: this.balance(input.userId), alreadyClawedBack });
    return Promise.resolve(this.insert({ userId: input.userId, delta, reason: 'refund', externalRef: `${input.orderRef}:refund:${target}` }) ? 'applied' : 'duplicate');
  }

  upsertSubscription(input: {
    userId: string;
    subscriptionId: string;
    orderId: string;
    entitlement: Entitlement;
    providerUpdatedAt: Date;
    now: Date;
  }): Promise<'applied' | 'stale' | 'other_subscription' | 'unknown_user'> {
    if (!this.users.has(input.userId)) return Promise.resolve('unknown_user');
    const current = this.entitlements.get(input.userId);
    if (current?.subscriptionId === input.subscriptionId) {
      if (current.providerUpdatedAt && current.providerUpdatedAt >= input.providerUpdatedAt) return Promise.resolve('stale');
    } else if (current?.subscriptionId && current.periodEnd > input.now && input.entitlement.periodEnd <= current.periodEnd) {
      return Promise.resolve('other_subscription');
    }
    this.entitlements.set(input.userId, { ...input.entitlement, subscriptionId: input.subscriptionId, orderId: input.orderId, providerUpdatedAt: input.providerUpdatedAt });
    return Promise.resolve('applied');
  }

  endSubscription(subscriptionId: string, entitlement: Entitlement): Promise<string | null> {
    for (const [userId, e] of this.entitlements) {
      if (e.subscriptionId === subscriptionId) {
        Object.assign(e, { periodStart: entitlement.periodStart, periodEnd: entitlement.periodEnd });
        return Promise.resolve(userId);
      }
    }
    return Promise.resolve(null);
  }

  endSubscriptionForOrder(orderId: string, entitlement: Entitlement): Promise<string | null> {
    for (const [userId, e] of this.entitlements) {
      if (e.orderId === orderId) {
        Object.assign(e, { periodStart: entitlement.periodStart, periodEnd: entitlement.periodEnd });
        return Promise.resolve(userId);
      }
    }
    return Promise.resolve(null);
  }

  async reservePath(input: { userId: string; pathRef: string }, decide: (state: LockedQuotaState) => Promise<PathCharge>): Promise<PathCharge> {
    const ref = `path:${input.pathRef}`;
    const earlier = this.ledger.find((r) => r.reason === 'path' && r.externalRef === ref);
    if (earlier) return earlier.delta === 0 ? 'plan' : 'credit';
    const charge = await decide({
      entitlement: this.entitlements.get(input.userId) ?? null,
      balance: this.balance(input.userId),
      usedPathsBetween: (from, to) =>
        Promise.resolve(this.ledger.filter((r) => r.userId === input.userId && r.reason === 'path' && r.delta === 0 && r.createdAt >= from && r.createdAt < to).length),
    });
    if (charge !== 'exceeded') this.insert({ userId: input.userId, delta: charge === 'plan' ? 0 : -1, reason: 'path', externalRef: ref });
    return charge;
  }
}

/** Scripted provider: checkout URLs and order items by order id. */
export class FakeBillingProvider implements BillingProvider {
  checkoutUrl = 'https://eduujoy.lemonsqueezy.com/checkout/custom/abc';
  readonly checkouts: { storeId: string; variantId: string; userId: string; testMode: boolean }[] = [];
  readonly orderItems = new Map<string, { variantId: string; quantity: number }[]>();
  failOrderItems = false;

  createCheckout(input: { storeId: string; variantId: string; userId: string; testMode: boolean }): Promise<{ url: string }> {
    this.checkouts.push(input);
    return Promise.resolve({ url: this.checkoutUrl });
  }

  listOrderItems(orderId: string): Promise<{ variantId: string; quantity: number }[]> {
    if (this.failOrderItems) return Promise.reject(new Error('Lemon Squeezy API returned HTTP 503'));
    return Promise.resolve(this.orderItems.get(orderId) ?? []);
  }
}
