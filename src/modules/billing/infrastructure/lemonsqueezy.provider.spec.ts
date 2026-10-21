import { AppConfig } from '../../../shared/config';
import { type Env } from '../../../shared/config/env';
import { LemonSqueezyApiError, LemonSqueezyProvider } from './lemonsqueezy.provider';

const KEY = 'ls-test-key-not-real';

function provider(respond: (url: string, init: RequestInit) => Response) {
  const calls: { url: string; init: RequestInit }[] = [];
  const fetcher = ((url: string, init: RequestInit) => {
    calls.push({ url, init });
    return Promise.resolve(respond(url, init));
  }) as unknown as typeof fetch;
  return { calls, ls: new LemonSqueezyProvider(new AppConfig({ LEMONSQUEEZY_API_KEY: KEY } as Env), fetcher) };
}

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/vnd.api+json' } });

describe('LemonSqueezyProvider', () => {
  it('creates a JSON:API checkout for one variant with our user id in custom data', async () => {
    const { calls, ls } = provider(() => json({ data: { id: '1', attributes: { url: 'https://eduujoy.lemonsqueezy.com/checkout/custom/1' } } }, 201));

    const result = await ls.createCheckout({ storeId: '100001', variantId: '200002', userId: 'u-1', testMode: true });

    expect(result).toEqual({ url: 'https://eduujoy.lemonsqueezy.com/checkout/custom/1' });
    const [call] = calls;
    expect(call?.url).toBe('https://api.lemonsqueezy.com/v1/checkouts');
    expect(call?.init).toMatchObject({ method: 'POST', redirect: 'error', headers: { Authorization: `Bearer ${KEY}`, Accept: 'application/vnd.api+json' } });
    expect(JSON.parse(call?.init.body as string)).toMatchObject({
      data: {
        type: 'checkouts',
        attributes: { product_options: { enabled_variants: [200002] }, checkout_data: { custom: { user_id: 'u-1' } }, test_mode: true },
        relationships: { store: { data: { type: 'stores', id: '100001' } }, variant: { data: { type: 'variants', id: '200002' } } },
      },
    });
  });

  it('lists order items by order id with their quantities', async () => {
    const { calls, ls } = provider(() => json({ data: [{ id: '9', type: 'order-items', attributes: { variant_id: 200002, quantity: 4 } }] }));

    await expect(ls.listOrderItems('5001')).resolves.toEqual([{ variantId: '200002', quantity: 4 }]);
    expect(calls[0]?.url).toBe('https://api.lemonsqueezy.com/v1/order-items?filter[order_id]=5001&page[size]=50');
    expect(calls[0]?.init.method).toBe('GET');
  });

  it('reports HTTP errors by status only, never the body or the key', async () => {
    const { ls } = provider(() => json({ errors: [{ detail: `echo ${KEY}` }] }, 422));

    const error = await ls.listOrderItems('5001').catch((e: unknown) => e);
    expect(error).toBeInstanceOf(LemonSqueezyApiError);
    expect((error as Error).message).toBe('Lemon Squeezy API returned HTTP 422');
    expect(JSON.stringify(error)).not.toContain(KEY);
  });

  it('rejects responses outside the documented shape', async () => {
    const { ls } = provider(() => json({ data: { attributes: { url: 'not a url' } } }));
    await expect(ls.createCheckout({ storeId: '1', variantId: '2', userId: 'u', testMode: false })).rejects.toThrow();
  });
});
