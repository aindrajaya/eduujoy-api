import { type JobQueue } from '../../../shared/jobs';
import { type BillingRepository } from './ports/billing.repository';
import { BILLING_EVENT_JOB } from './receive-webhook.usecase';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export type ReprocessResult =
  | { outcome: 'not_found' }
  | { outcome: 'already_processed'; type: string; processedAt: Date }
  | { outcome: 'would_queue'; type: string }
  | { outcome: 'queued'; type: string; jobId: string };

/**
 * Operator recovery (`pnpm billing:reprocess`): queues a fresh `billing-event` job for a stored webhook
 * that was never processed, e.g. after a refused order-items lookup (wrong-mode key, or order items not
 * readable yet). Only events with processed_at null are queued. Running it twice is safe: the handler
 * skips processed events, and the ledger's unique (reason, external_ref) credits an order once.
 */
export class ReprocessBillingEvent {
  constructor(
    private readonly repo: Pick<BillingRepository, 'findEvent'>,
    private readonly queue: Pick<JobQueue, 'enqueue'>,
    private readonly clock: () => Date = () => new Date(),
  ) {}

  async execute(eventId: string, options: { dryRun: boolean }): Promise<ReprocessResult> {
    if (!UUID.test(eventId)) return { outcome: 'not_found' };
    const event = await this.repo.findEvent(eventId);
    if (!event) return { outcome: 'not_found' };
    if (event.processedAt) return { outcome: 'already_processed', type: event.type, processedAt: event.processedAt };
    if (options.dryRun) return { outcome: 'would_queue', type: event.type };
    const { job } = await this.queue.enqueue({
      type: BILLING_EVENT_JOB,
      // A new key per run: the first job's key is taken by the dead attempt.
      idempotencyKey: `billing:${event.id}:reprocess:${this.clock().toISOString()}`,
      payload: { eventId: event.id },
      maxAttempts: 5,
    });
    return { outcome: 'queued', type: event.type, jobId: job.id };
  }
}
