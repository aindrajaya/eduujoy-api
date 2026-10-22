import { type DbExecutor } from '../../db';
import { reviewItems } from '../../db/schema/admin';

export type ReviewKind = 'diagnostic_item' | 'resource' | 'path' | 'learner_report';

export interface ReviewFlag {
  kind: ReviewKind;
  /** The flagged row, e.g. a resource card id. */
  targetId: string;
  reason: string;
  detail?: Record<string, unknown>;
}

/**
 * Adds rows to the admin review queue (FR-24) from any module, in the caller's transaction. Shared
 * because modules may not write another module's tables; the admin module (A13) reads and resolves them.
 */
export class ReviewQueue {
  async flag(executor: DbExecutor, flag: ReviewFlag): Promise<void> {
    await executor.insert(reviewItems).values({ kind: flag.kind, targetId: flag.targetId, reason: flag.reason, detail: flag.detail ?? null });
  }
}
