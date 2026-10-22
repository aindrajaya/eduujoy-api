import { Inject, Injectable } from '@nestjs/common';
import { AppConfig } from '../../../shared/config';
import { type Product } from '../domain/billing-rules';
import { CheckoutUnavailableError } from './errors';
import { BILLING_PROVIDER, type BillingProvider } from './ports/billing-provider';

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
  constructor(
    @Inject(BILLING_PROVIDER) private readonly provider: BillingProvider,
    private readonly config: AppConfig,
  ) {}

  async execute(userId: string, product: Product): Promise<{ url: string }> {
    const env = this.config.env;
    const variantId = product === 'subscription' ? env.LEMONSQUEEZY_VARIANT_SUBSCRIPTION : env.LEMONSQUEEZY_VARIANT_CREDIT_PACK;
    const { url } = await this.provider.createCheckout({
      storeId: env.LEMONSQUEEZY_STORE_ID,
      variantId,
      userId,
      testMode: env.LEMONSQUEEZY_MODE === 'test',
    });
    if (!isProviderCheckoutUrl(url)) throw new CheckoutUnavailableError('Provider returned an unexpected checkout URL');
    return { url };
  }
}
