import { type SubscriptionStatus } from '../../domain/billing-rules';

export const NOTIFICATION_PARSER = Symbol('NotificationParser');

/** A provider webhook, reduced to what billing acts on. Provider ids are strings. */
export type BillingNotification =
  | {
      kind: 'order';
      event: 'order_created' | 'order_refunded';
      orderId: string;
      userId: string | null;
      variantId: string;
      status: string;
      refunded: boolean;
      refundedAmount: number;
      total: number;
      testMode: boolean;
    }
  | {
      kind: 'subscription';
      event: string;
      subscriptionId: string;
      /** The order that started the subscription. */
      orderId: string;
      userId: string | null;
      variantId: string;
      status: SubscriptionStatus;
      renewsAt: Date | null;
      endsAt: Date | null;
      updatedAt: Date;
      testMode: boolean;
    }
  | { kind: 'subscription_refund'; subscriptionId: string; refunded: boolean; testMode: boolean }
  | { kind: 'ignored'; event: string; testMode: boolean | null };

export interface NotificationParser {
  /** Null when the payload doesn't have the documented shape. */
  parse(payload: unknown): BillingNotification | null;
}
