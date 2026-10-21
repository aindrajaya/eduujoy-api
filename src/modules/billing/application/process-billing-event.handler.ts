import { Inject, Injectable, Logger } from '@nestjs/common';
import { z } from 'zod';
import { AppConfig } from '../../../shared/config';
import { EventBus } from '../../../shared/events';
import { type JobHandler, type JobOutcome } from '../../../shared/jobs';
import { ended, entitlementFor, packCredits, refundClawback } from '../domain/billing-rules';
import { EntitlementChanged } from '../domain/events/entitlement-changed.event';
import { type BillingNotification, NOTIFICATION_PARSER, type NotificationParser } from './ports/billing-notification';
import { BILLING_PROVIDER, type BillingProvider } from './ports/billing-provider';
import { BILLING_REPOSITORY, type BillingRepository } from './ports/billing.repository';
import { BILLING_EVENT_JOB } from './receive-webhook.usecase';

const payloadSchema = z.object({ eventId: z.uuid() }).strict();

interface Effect {
  outcome: string;
  changed?: { userId: string; reason: EntitlementChanged['reason'] };
}

/**
 * Applies one stored Lemon Squeezy webhook (A12). Idempotent: an event is processed once, a purchase
 * credits once per order, refunds and subscription updates are keyed so a retry or replay changes
 * nothing. Runs one at a time, so events for the same order or subscription never interleave.
 */
@Injectable()
export class ProcessBillingEvent implements JobHandler<{ eventId: string }> {
  readonly type = BILLING_EVENT_JOB;
  readonly concurrency = 1;
  readonly timeoutMs = 30_000;
  private readonly logger = new Logger(ProcessBillingEvent.name);

  constructor(
    @Inject(BILLING_REPOSITORY) private readonly repo: BillingRepository,
    @Inject(NOTIFICATION_PARSER) private readonly parser: NotificationParser,
    @Inject(BILLING_PROVIDER) private readonly provider: BillingProvider,
    private readonly config: AppConfig,
    private readonly events: EventBus,
  ) {}

  parse(payload: unknown): { eventId: string } {
    return payloadSchema.parse(payload);
  }

  async run({ eventId }: { eventId: string }): Promise<JobOutcome> {
    const resultRef = `/billing/events/${eventId}`;
    const event = await this.repo.findEvent(eventId);
    if (!event || event.processedAt) return { resultRef, result: { outcome: 'already_processed' } };

    const effect = await this.apply(this.parser.parse(event.payload));
    await this.repo.markProcessed(eventId, effect.outcome);
    if (effect.outcome.startsWith('held:') || effect.outcome.includes('shortfall')) {
      this.logger.warn({ eventId, type: event.type, outcome: effect.outcome }, 'Billing event needs review');
    } else {
      this.logger.log({ eventId, type: event.type, outcome: effect.outcome }, 'Billing event processed');
    }
    if (effect.changed) await this.events.publish(new EntitlementChanged(effect.changed.userId, effect.changed.reason));
    return { resultRef, result: { outcome: effect.outcome } };
  }

  private async apply(n: BillingNotification | null): Promise<Effect> {
    if (!n) return { outcome: 'ignored:invalid_payload' };
    if (n.kind === 'ignored') return { outcome: `ignored:event:${n.event}` };
    // A test-mode event must never change a live deployment, or the other way round.
    if (n.testMode !== (this.config.env.LEMONSQUEEZY_MODE === 'test')) return { outcome: 'ignored:mode_mismatch' };
    const now = new Date();
    switch (n.kind) {
      case 'order':
        return n.event === 'order_created' ? this.orderCreated(n) : this.orderRefunded(n, now);
      case 'subscription':
        return this.subscriptionChanged(n, now);
      case 'subscription_refund': {
        if (!n.refunded) return { outcome: 'logged:partial_subscription_refund' };
        const userId = await this.repo.endSubscription(n.subscriptionId, ended(now));
        return userId ? { outcome: 'subscription:ended_refund', changed: { userId, reason: 'refund' } } : { outcome: 'ignored:unknown_subscription' };
      }
    }
  }

  private variant(variantId: string): 'subscription' | 'credit_pack' | null {
    const env = this.config.env;
    if (variantId === env.LEMONSQUEEZY_VARIANT_CREDIT_PACK) return 'credit_pack';
    if (variantId === env.LEMONSQUEEZY_VARIANT_SUBSCRIPTION) return 'subscription';
    return null;
  }

  private async orderCreated(n: Extract<BillingNotification, { kind: 'order' }>): Promise<Effect> {
    const product = this.variant(n.variantId);
    if (product !== 'credit_pack') return { outcome: product ? 'ignored:subscription_order' : 'ignored:unknown_variant' };
    if (n.status !== 'paid') return { outcome: `ignored:order_${n.status}` };
    if (!n.userId) return { outcome: 'held:no_user' };
    // The webhook carries no quantity; the order items are the source of truth, never the client.
    const items = await this.provider.listOrderItems(n.orderId);
    const quantity = items.filter((i) => i.variantId === n.variantId).reduce((sum, i) => sum + i.quantity, 0);
    const credits = packCredits(quantity);
    if (credits === null) return { outcome: `held:quantity_${quantity}` };
    const granted = await this.repo.grantPurchase({ userId: n.userId, credits, orderRef: orderRef(n.orderId) });
    if (granted === 'granted') return { outcome: `credited:${credits}`, changed: { userId: n.userId, reason: 'purchase' } };
    return { outcome: granted === 'duplicate' ? 'ignored:already_credited' : 'held:unknown_user' };
  }

  private async orderRefunded(n: Extract<BillingNotification, { kind: 'order' }>, now: Date): Promise<Effect> {
    const product = this.variant(n.variantId);
    if (product === 'subscription') {
      // A refunded first subscription order ends the plan at once (user decision, 22 Oct 2026).
      if (!n.refunded || !n.userId) return { outcome: 'logged:partial_subscription_refund' };
      const subscriptionId = await this.repo.subscriptionOf(n.userId);
      const userId = subscriptionId ? await this.repo.endSubscription(subscriptionId, ended(now)) : null;
      return userId ? { outcome: 'subscription:ended_refund', changed: { userId, reason: 'refund' } } : { outcome: 'ignored:unknown_subscription' };
    }
    if (product !== 'credit_pack') return { outcome: 'ignored:unknown_variant' };
    const ref = orderRef(n.orderId);
    const purchase = await this.repo.findPurchase(ref);
    if (!purchase) return { outcome: 'ignored:no_purchase' };
    let outcome = { target: 0, delta: 0, shortfall: 0 };
    const applied = await this.repo.applyRefund({ userId: purchase.userId, orderRef: ref }, (state) => {
      outcome = refundClawback({ granted: purchase.credits, refundedAmount: n.refundedAmount, total: n.total, ...state });
      return outcome;
    });
    if (applied === 'duplicate') return { outcome: 'ignored:refund_already_applied' };
    const text = `refunded:${-outcome.delta}${outcome.shortfall > 0 ? `:shortfall_${outcome.shortfall}` : ''}`;
    return { outcome: text, changed: { userId: purchase.userId, reason: 'refund' } };
  }

  private async subscriptionChanged(n: Extract<BillingNotification, { kind: 'subscription' }>, now: Date): Promise<Effect> {
    if (this.variant(n.variantId) !== 'subscription') return { outcome: 'ignored:unknown_variant' };
    if (!n.userId) return { outcome: 'held:no_user' };
    const result = await this.repo.upsertSubscription({
      userId: n.userId,
      subscriptionId: n.subscriptionId,
      entitlement: entitlementFor(n, now),
      providerUpdatedAt: n.updatedAt,
    });
    if (result === 'applied') return { outcome: `subscription:${n.status}`, changed: { userId: n.userId, reason: 'subscription' } };
    return { outcome: result === 'stale' ? 'ignored:stale_subscription_update' : 'held:unknown_user' };
  }
}

/** Ledger key for a provider order: purchases are unique per order, refunds per order and target. */
export const orderRef = (orderId: string): string => `ls-order:${orderId}`;
