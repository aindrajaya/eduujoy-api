import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import { Inject, Injectable, Logger } from '@nestjs/common';
import { AppConfig } from '../../../shared/config';
import { UnitOfWork } from '../../../shared/events';
import { JobQueue } from '../../../shared/jobs';
import { BILLING_REPOSITORY, type BillingRepository } from './ports/billing.repository';

export const BILLING_EVENT_JOB = 'billing-event';

export class WebhookSignatureError extends Error {
  override name = 'WebhookSignatureError';
}

/** Lemon Squeezy signs the raw body: X-Signature is the hex HMAC-SHA256 keyed with the signing secret. */
export function verifySignature(rawBody: Buffer, signature: string | undefined, secret: string): boolean {
  if (!signature || !/^[0-9a-f]{64}$/i.test(signature)) return false;
  const expected = Buffer.from(createHmac('sha256', secret).update(rawBody).digest('hex'), 'utf8');
  const given = Buffer.from(signature.toLowerCase(), 'utf8');
  return expected.length === given.length && timingSafeEqual(expected, given);
}

export type WebhookResult = 'accepted' | 'replay' | 'unparseable';

/**
 * POST /v1/billing/webhook. Verifies the signature over the raw bytes before parsing anything, stores
 * the event once (keyed by the SHA-256 of the body, so a redelivery is a no-op) and enqueues its
 * processing in the same transaction. Effects happen in the `billing-event` job, never in the request.
 */
@Injectable()
export class ReceiveWebhook {
  private readonly logger = new Logger(ReceiveWebhook.name);

  constructor(
    @Inject(BILLING_REPOSITORY) private readonly repo: BillingRepository,
    private readonly uow: UnitOfWork,
    private readonly queue: JobQueue,
    private readonly config: AppConfig,
  ) {}

  async execute(rawBody: Buffer | undefined, signature: string | undefined): Promise<WebhookResult> {
    if (!rawBody || !verifySignature(rawBody, signature, this.config.env.LEMONSQUEEZY_WEBHOOK_SECRET)) {
      throw new WebhookSignatureError('Invalid webhook signature');
    }
    let payload: unknown;
    try {
      payload = JSON.parse(rawBody.toString('utf8'));
    } catch {
      // Signed but not JSON: acknowledge so the provider stops retrying, and leave a trace.
      this.logger.warn({ bytes: rawBody.length }, 'Signed billing webhook is not JSON; ignored');
      return 'unparseable';
    }
    const meta = (payload as { meta?: { event_name?: unknown } } | null)?.meta;
    const type = typeof meta?.event_name === 'string' ? meta.event_name.slice(0, 64) : 'unknown';
    const providerEventId = createHash('sha256').update(rawBody).digest('hex');

    return this.uow.run(async (tx, scope) => {
      const id = await this.repo.recordEvent(tx, { providerEventId, type, payload });
      if (!id) return 'replay';
      await this.queue.enqueue({ type: BILLING_EVENT_JOB, idempotencyKey: `billing:${id}`, payload: { eventId: id }, maxAttempts: 5 }, { tx, scope });
      return 'accepted';
    });
  }
}
