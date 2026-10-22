import { Injectable } from '@nestjs/common';
import { z } from 'zod';
import { AppConfig } from '../../../shared/config';
import { type BillingProvider } from '../application/ports/billing-provider';

const API = 'https://api.lemonsqueezy.com/v1';
const TIMEOUT_MS = 10_000;
const MAX_ORDER_ITEMS = 50;

const checkoutResponse = z.object({ data: z.object({ attributes: z.object({ url: z.url() }) }) });
const orderItemsResponse = z.object({
  data: z
    .array(
      z.object({
        attributes: z.object({
          variant_id: z.union([z.string(), z.number()]).transform(String),
          quantity: z.number().int().positive(),
        }),
      }),
    )
    .max(MAX_ORDER_ITEMS),
});

export class LemonSqueezyApiError extends Error {
  override name = 'LemonSqueezyApiError';

  constructor(readonly status: number) {
    // Status only: response bodies can echo request data, and the key must never reach a log.
    super(`Lemon Squeezy API returned HTTP ${status}`);
  }
}

/** Lemon Squeezy REST API (JSON:API), docs.lemonsqueezy.com/api. */
@Injectable()
export class LemonSqueezyProvider implements BillingProvider {
  constructor(
    private readonly config: AppConfig,
    private readonly fetcher: typeof fetch = (input, init) => fetch(input, init),
  ) {}

  async createCheckout(input: { storeId: string; variantId: string; userId: string; testMode: boolean; redirectUrl: string; quantity: number }): Promise<{ url: string }> {
    const body = {
      data: {
        type: 'checkouts',
        attributes: {
          // After payment Lemon Squeezy sends the learner back here; the webhook still decides the plan.
          product_options: { enabled_variants: [Number(input.variantId)], redirect_url: input.redirectUrl },
          // Our user id comes back in every order and subscription webhook as meta.custom_data.
          // variant_quantities presets the quantity (docs.lemonsqueezy.com/api/checkouts/create-checkout:
          // "checkout_data ... variant_quantities, a list of objects with variant_id and quantity").
          checkout_data: {
            custom: { user_id: input.userId },
            variant_quantities: [{ variant_id: Number(input.variantId), quantity: input.quantity }],
          },
          expires_at: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(),
          test_mode: input.testMode,
        },
        relationships: {
          store: { data: { type: 'stores', id: input.storeId } },
          variant: { data: { type: 'variants', id: input.variantId } },
        },
      },
    };
    const json = await this.request('POST', '/checkouts', body);
    return { url: checkoutResponse.parse(json).data.attributes.url };
  }

  async listOrderItems(orderId: string): Promise<{ variantId: string; quantity: number }[]> {
    const json = await this.request('GET', `/order-items?filter[order_id]=${encodeURIComponent(orderId)}&page[size]=${MAX_ORDER_ITEMS}`);
    return orderItemsResponse.parse(json).data.map((d) => ({ variantId: d.attributes.variant_id, quantity: d.attributes.quantity }));
  }

  private async request(method: 'GET' | 'POST', path: string, body?: unknown): Promise<unknown> {
    const response = await this.fetcher(`${API}${path}`, {
      method,
      headers: {
        Accept: 'application/vnd.api+json',
        'Content-Type': 'application/vnd.api+json',
        Authorization: `Bearer ${this.config.env.LEMONSQUEEZY_API_KEY}`,
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: AbortSignal.timeout(TIMEOUT_MS),
      redirect: 'error',
    });
    if (!response.ok) throw new LemonSqueezyApiError(response.status);
    return response.json();
  }
}
