import { Inject, Injectable, Logger } from '@nestjs/common';
import { AppConfig } from '../../../shared/config';
import { type Product } from '../domain/billing-rules';
import { isActive } from '../domain/quota';
import { CheckoutUnavailableError, SubscriptionActiveError } from './errors';
import { BILLING_PROVIDER, type BillingProvider } from './ports/billing-provider';
import { QUOTA_REPOSITORY, type QuotaRepository } from './ports/quota.repository';

/** Where Lemon Squeezy returns the learner (contract 0.6.0); the flag is a hint, the webhook changes the plan. */
export const CHECKOUT_RETURN_PATH = '/account?checkout=success';

/** Lemon Squeezy hosts checkouts on its own domain; anything else is refused rather than sent to the UI. */
export function isProviderCheckoutUrl(url: string): boolean {
  try {
    const { protocol, hostname } = new URL(url);
    return protocol === 'https:' && (hostname === 'lemonsqueezy.com' || hostname.endsWith('.lemonsqueezy.com'));
  } catch {
    return false;
  }
}

/** POST /v1/billing/checkout (FR-23). Credits come only from the webhook, never from this request. */
@Injectable()
export class CreateCheckout {
  private readonly logger = new Logger(CreateCheckout.name);

  constructor(
    @Inject(BILLING_PROVIDER) private readonly provider: BillingProvider,
    @Inject(QUOTA_REPOSITORY) private readonly quota: QuotaRepository,
    private readonly config: AppConfig,
  ) {}

  /** `origin` is the request's Origin, which CsrfGuard has already matched against APP_ORIGIN. */
  async execute(userId: string, product: Product, origin: string | undefined, quantity = 1): Promise<{ url: string }> {
    const env = this.config.env;
    if (product === 'subscription' && isActive(await this.quota.findEntitlement(userId), new Date())) {
      throw new SubscriptionActiveError('A subscription is already active');
    }
    // Never redirect anywhere but an allow-listed app origin, even if a caller bypassed the guard.
    const appOrigin = origin && env.APP_ORIGIN.includes(origin) ? origin : env.APP_ORIGIN[0];
    const variantId = product === 'subscription' ? env.LEMONSQUEEZY_VARIANT_SUBSCRIPTION : env.LEMONSQUEEZY_VARIANT_CREDIT_PACK;
    let url: string;
    try {
      ({ url } = await this.provider.createCheckout({
        storeId: env.LEMONSQUEEZY_STORE_ID,
        variantId,
        userId,
        testMode: env.LEMONSQUEEZY_MODE === 'test',
        redirectUrl: `${appOrigin ?? ''}${CHECKOUT_RETURN_PATH}`,
        // The DTO allows a quantity only with credit packs; a subscription is always 1.
        quantity: product === 'credit_pack' ? quantity : 1,
      }));
    } catch (error) {
      this.logger.warn({ err: error instanceof Error ? error : new Error(String(error)) }, 'Checkout provider failed');
      throw new CheckoutUnavailableError('Payment provider unavailable');
    }
    if (!isProviderCheckoutUrl(url)) throw new CheckoutUnavailableError('Provider returned an unexpected checkout URL');
    return { url };
  }
}
