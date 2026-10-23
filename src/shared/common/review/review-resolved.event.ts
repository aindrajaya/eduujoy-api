import { type ReviewKind } from './review-queue';

/**
 * A reviewer resolved a review item (FR-24). Shared like ReviewQueue: the admin module (A13) publishes
 * it, and the module that owns the flagged row acts on it (pathing refunds a rejected path).
 */
export class ReviewResolved {
  readonly type = 'ReviewResolved';
  readonly occurredAt = new Date();

  constructor(
    readonly reviewItemId: string,
    readonly kind: ReviewKind,
    readonly targetId: string,
    readonly resolution: 'approved' | 'rejected' | 'edited',
  ) {}
}
