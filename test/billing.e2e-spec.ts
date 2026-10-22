import { createHmac, randomUUID } from 'node:crypto';
import { eq, isNull } from 'drizzle-orm';
import request from 'supertest';
import { FakeBillingProvider } from '../src/modules/billing/application/billing.fakes';
import { QuotaExceededError } from '../src/modules/billing/application/errors';
import { BILLING_PROVIDER } from '../src/modules/billing/application/ports/billing-provider';
import { ReservePath } from '../src/modules/billing/application/reserve-path.usecase';
import { AccessTokenService } from '../src/shared/common/auth';
import { DATABASE, type Database } from '../src/shared/db';
import { billingEvents, creditLedger } from '../src/shared/db/schema/billing';
import { users } from '../src/shared/db/schema/identity';
import { createTestApp, type TestApp } from './app';
import { orderEvent, subscriptionEvent, VARIANTS } from './fixtures/billing/payloads';

const csrf = { Origin: 'http://localhost:5173', 'X-Requested-With': 'eduujoy' };
const SECRET = process.env['LEMONSQUEEZY_WEBHOOK_SECRET'] ?? '';
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

interface MeBody {
  plan: string;
  quota: { monthlyPaths: number; usedPaths: number; credits: number; periodEnd: string };
}

jest.setTimeout(60_000);

describe('billing (e2e, PRD-API §13 A12 Verify)', () => {
  let app: TestApp;
  let db: Database;
  const provider = new FakeBillingProvider();

  beforeAll(async () => {
    app = await createTestApp((builder) => builder.overrideProvider(BILLING_PROVIDER).useValue(provider));
    db = app.get<Database>(DATABASE);
  });

  afterAll(async () => {
    await app.close();
  });

  const http = () => request(app.getHttpServer());

  async function signedInUser(): Promise<{ userId: string; cookie: string }> {
    const [user] = await db.insert(users).values({ email: `billing-${randomUUID()}@example.com` }).returning();
    const userId = user?.id ?? '';
    const token = await app.get(AccessTokenService).sign({ userId, sessionId: randomUUID(), roles: ['learner'], plan: 'free' });
    return { userId, cookie: `ej_at=${token}` };
  }

  /** Posts the body exactly as Lemon Squeezy would: raw JSON bytes, hex HMAC in X-Signature, no cookie or CSRF headers. */
  function webhook(payload: unknown, signature?: string) {
    const raw = JSON.stringify(payload);
    return http()
      .post('/v1/billing/webhook')
      .set('Content-Type', 'application/json')
      .set('X-Event-Name', (payload as { meta: { event_name: string } }).meta.event_name)
      .set('X-Signature', signature ?? createHmac('sha256', SECRET).update(raw).digest('hex'))
      .send(raw);
  }

  /** The billing-event job runs on the real executor; wait until every stored event is processed. */
  async function settled(): Promise<void> {
    // Up to 30 s: the executor's claim and the job's writes are each Neon round trips.
    for (let i = 0; i < 600; i++) {
      if ((await db.$count(billingEvents, isNull(billingEvents.processedAt))) === 0) return;
      await sleep(50);
    }
    throw new Error('billing events still pending');
  }

  const me = async (cookie: string) => (await http().get('/v1/auth/me').set('Cookie', cookie).expect(200)).body as MeBody;
  const ledgerFor = (userId: string) => db.select().from(creditLedger).where(eq(creditLedger.userId, userId));

  it('credits a signed credit-pack order once; a replayed webhook is ignored', async () => {
    const { userId, cookie } = await signedInUser();
    const orderId = Math.floor(Math.random() * 1e9);
    provider.orderItems.set(String(orderId), [{ variantId: VARIANTS.creditPack, quantity: 2 }]);
    const payload = orderEvent({ userId, orderId });

    await webhook(payload).expect(200);
    await settled();
    expect((await me(cookie)).quota.credits).toBe(2);

    // The exact redelivery and a re-sent variant of the same order both leave the balance alone.
    await webhook(payload).expect(200);
    await webhook({ ...payload, meta: { ...(payload['meta'] as object), retried: true } }).expect(200);
    await settled();
    expect((await me(cookie)).quota.credits).toBe(2);
    expect(await ledgerFor(userId)).toHaveLength(1);
  });

  it('rejects a missing or wrong signature with 401 and stores nothing', async () => {
    const { userId } = await signedInUser();
    const payload = orderEvent({ userId, orderId: 1 });
    const before = await db.$count(billingEvents);

    await webhook(payload, 'f'.repeat(64)).expect(401);
    await webhook(payload, '').expect(401);
    const tampered = await http()
      .post('/v1/billing/webhook')
      .set('Content-Type', 'application/json')
      .set('X-Signature', createHmac('sha256', SECRET).update(JSON.stringify(payload)).digest('hex'))
      .send(JSON.stringify({ ...payload, meta: { event_name: 'order_created', custom_data: { user_id: randomUUID() } } }))
      .expect(401);
    expect((tampered.body as { code: string; detail?: string }).code).toBe('UNAUTHENTICATED');
    expect((tampered.body as { detail?: string }).detail).toBeUndefined();
    expect(await db.$count(billingEvents)).toBe(before);
  });

  it('ignores a live-mode event in this test-mode deployment', async () => {
    const { userId, cookie } = await signedInUser();
    const orderId = Math.floor(Math.random() * 1e9);
    provider.orderItems.set(String(orderId), [{ variantId: VARIANTS.creditPack, quantity: 1 }]);

    await webhook(orderEvent({ userId, orderId, testMode: false })).expect(200);
    await settled();

    expect((await me(cookie)).quota.credits).toBe(0);
    const [event] = await db.select().from(billingEvents).where(eq(billingEvents.outcome, 'ignored:mode_mismatch'));
    expect(event).toBeDefined();
  });

  it('turns a subscription into 8 paths per month on /auth/me and back to free when it expires', async () => {
    const { userId, cookie } = await signedInUser();
    const subscriptionId = Math.floor(Math.random() * 1e9);

    await webhook(subscriptionEvent({ userId, subscriptionId, updatedAt: '2026-10-22T10:00:00Z' })).expect(200);
    await settled();
    expect(await me(cookie)).toMatchObject({ plan: 'subscription', quota: { monthlyPaths: 8 } });

    await webhook(subscriptionEvent({ event: 'subscription_expired', userId, subscriptionId, status: 'expired', updatedAt: '2026-10-23T10:00:00Z' })).expect(200);
    await settled();
    expect(await me(cookie)).toMatchObject({ plan: 'free', quota: { monthlyPaths: 1 } });
  });

  it('blocks generation once the plan allowance and credits are used up', async () => {
    const { userId, cookie } = await signedInUser();
    const orderId = Math.floor(Math.random() * 1e9);
    provider.orderItems.set(String(orderId), [{ variantId: VARIANTS.creditPack, quantity: 1 }]);
    await webhook(orderEvent({ userId, orderId })).expect(200);
    await settled();
    const reserve = app.get(ReservePath);

    await expect(reserve.execute(userId, 'path-1')).resolves.toBe('plan');
    await expect(reserve.execute(userId, 'path-2')).resolves.toBe('credit');
    await expect(reserve.execute(userId, 'path-3')).rejects.toBeInstanceOf(QuotaExceededError);
    expect((await me(cookie)).quota).toMatchObject({ monthlyPaths: 1, usedPaths: 1, credits: 0 });
  });

  it('creates a checkout for the signed-in learner, with CSRF and validation', async () => {
    const { userId, cookie } = await signedInUser();
    const checkout = (body: unknown) => http().post('/v1/billing/checkout').set(csrf).set('Cookie', cookie).send(body as object);

    const res = await checkout({ product: 'credit_pack' }).expect(200);
    expect(res.body).toEqual({ url: provider.checkoutUrl });
    expect(provider.checkouts.at(-1)).toEqual({ storeId: '100001', variantId: VARIANTS.creditPack, userId, testMode: true });

    await checkout({ product: 'gold' }).expect(400);
    await checkout({ product: 'credit_pack', quantity: 5 }).expect(400);
    await http().post('/v1/billing/checkout').set('Cookie', cookie).send({ product: 'subscription' }).expect(403);
    await http().post('/v1/billing/checkout').set(csrf).send({ product: 'subscription' }).expect(401);
  });
});
