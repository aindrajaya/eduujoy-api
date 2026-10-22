import { randomUUID } from 'node:crypto';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { eq, inArray } from 'drizzle-orm';
import { type Client } from 'pg';
import { DeleteAccount } from '../../src/modules/account/application/delete-account.usecase';
import { DeletedUsers } from '../../src/shared/common/auth/deleted-users';
import { AssessmentAccountData } from '../../src/modules/assessment/infrastructure/assessment-account-data';
import { BillingAccountData, STRIPPED_PAYLOAD_PATHS } from '../../src/modules/billing/infrastructure/billing-account-data';
import { CatalogAccountData } from '../../src/modules/catalog/infrastructure/catalog-account-data';
import { GetSessionAuthTime } from '../../src/modules/identity/application/get-session-auth-time.query';
import { DrizzleSessionRepository } from '../../src/modules/identity/infrastructure/drizzle-session.repository';
import { IdentityAccountData } from '../../src/modules/identity/infrastructure/identity-account-data';
import { ProgressAccountData } from '../../src/modules/progress/infrastructure/progress-account-data';
import { diagnosticSessions, placements } from '../../src/shared/db/schema/assessment';
import { billingEvents, creditLedger, entitlements } from '../../src/shared/db/schema/billing';
import { topics } from '../../src/shared/db/schema/catalog';
import { loginAttempts, sessions, users } from '../../src/shared/db/schema/identity';
import { jobs } from '../../src/shared/db/schema/jobs';
import { learnerPositions } from '../../src/shared/db/schema/progress';
import { EventBus } from '../../src/shared/events/event-bus';
import { UnitOfWork } from '../../src/shared/events/unit-of-work';
import { JobRepository } from '../../src/shared/jobs/job.repository';
import { connectTestClient, testDb, testSchema, type TestDb } from '../db/connect';

/** A learner with data in every module, plus a bystander whose data must survive untouched. */
async function seedLearner(db: TestDb, tag: string) {
  const email = `Delete.Me-${tag}@Example.com`;
  const name = `Learner ${tag}`;
  const [user] = await db.insert(users).values({ email, name }).returning();
  const userId = user?.id ?? '';
  const [session] = await db
    .insert(sessions)
    .values({ userId, familyId: randomUUID(), refreshHash: randomUUID(), userAgent: 'jest', ipHash: 'ip', authTime: new Date(), expiresAt: new Date(Date.now() + 3_600_000) })
    .returning();
  await db.insert(loginAttempts).values({ email: email.toLowerCase(), ipHash: 'ip', succeeded: true });
  const [topic] = await db.insert(topics).values({ slug: `del-${tag}`, canonicalName: `Deletion topic ${tag}`, origin: 'learner', createdBy: userId }).returning();
  const topicId = topic?.id ?? '';
  const [diag] = await db.insert(diagnosticSessions).values({ userId, topicId, goal: `my goal ${tag}`, weeklyHours: 3, state: {} }).returning();
  await db.insert(placements).values({ sessionId: diag?.id ?? '', userId, topicId, stage: 'novice', bloom: 'C1', confidence: 0.5, reason: 'r' });
  await db.insert(learnerPositions).values({ userId, topicId, stage: 'novice', bloom: 'C1', confidence: 0.5, source: 'diagnostic' });
  const orderId = String(Math.floor(Math.random() * 1e9));
  const subscriptionId = String(Math.floor(Math.random() * 1e9));
  await db.insert(creditLedger).values([
    { userId, delta: 2, reason: 'purchase', externalRef: `ls-order:${orderId}` },
    { userId, delta: -1, reason: 'path', externalRef: `path:${randomUUID()}` },
  ]);
  await db.insert(entitlements).values({ userId, plan: 'subscription', monthlyPathQuota: 8, periodStart: new Date(), periodEnd: new Date(Date.now() + 86_400_000), providerSubscriptionId: subscriptionId, providerOrderId: `${orderId}9` });
  const pii = { user_name: name, user_email: email, card_brand: 'visa', card_last_four: '4242', urls: { customer_portal: 'https://x.lemonsqueezy.com/billing?signed=abc' } };
  const [withUser, bySubscription] = await db
    .insert(billingEvents)
    .values([
      { providerEventId: randomUUID(), type: 'order_created', payload: { meta: { event_name: 'order_created', custom_data: { user_id: userId } }, data: { type: 'orders', id: orderId, attributes: { total: 400, ...pii } } } },
      // An invoice event without our custom data, tied to the learner only by the subscription id.
      { providerEventId: randomUUID(), type: 'subscription_payment_success', payload: { meta: { event_name: 'subscription_payment_success' }, data: { type: 'subscription-invoices', id: '1', attributes: { subscription_id: Number(subscriptionId), ...pii } } } },
    ])
    .returning();
  const [queued, running] = await db
    .insert(jobs)
    .values([
      { type: 'x-test', idempotencyKey: randomUUID(), userId, payload: { n: 1 } },
      { type: 'x-test', idempotencyKey: randomUUID(), userId, payload: { n: 2 }, status: 'running', lockedAt: new Date() },
    ])
    .returning();
  return { userId, email, name, sessionId: session?.id ?? '', topicId, orderId, subscriptionId, events: [withUser?.id ?? '', bySubscription?.id ?? ''], jobs: { queued: queued?.id ?? '', running: running?.id ?? '' } };
}

describe('Account deletion (integration, A13 gate)', () => {
  let client: Client;
  let db: TestDb;
  let deleter: DeleteAccount;

  beforeAll(async () => {
    client = await connectTestClient();
    db = testDb(client);
    deleter = new DeleteAccount(
      new GetSessionAuthTime(new DrizzleSessionRepository(db)),
      new UnitOfWork(db, new EventBus(new EventEmitter2())),
      new JobRepository(db),
      new BillingAccountData(db),
      new IdentityAccountData(db),
      new DeletedUsers(),
    );
  });

  afterAll(async () => {
    await client.end();
  });

  it('removes personal data, keeps anonymised billing and unlinked topics, and leaves others untouched', async () => {
    const tag = randomUUID().slice(0, 8);
    const me = await seedLearner(db, tag);
    const other = await seedLearner(db, `zz${tag}`);
    const exportBefore = await new IdentityAccountData(db).export(other.userId);

    await deleter.execute(me.userId, me.sessionId);

    // Removed: the user and everything that cascades from it.
    expect(await db.select().from(users).where(eq(users.id, me.userId))).toEqual([]);
    expect(await db.select().from(sessions).where(eq(sessions.userId, me.userId))).toEqual([]);
    expect(await db.select().from(loginAttempts).where(eq(loginAttempts.email, me.email.toLowerCase()))).toEqual([]);
    expect(await db.select().from(diagnosticSessions).where(eq(diagnosticSessions.userId, me.userId))).toEqual([]);
    expect(await db.select().from(placements).where(eq(placements.userId, me.userId))).toEqual([]);
    expect(await db.select().from(learnerPositions).where(eq(learnerPositions.userId, me.userId))).toEqual([]);
    expect(await db.select().from(entitlements).where(eq(entitlements.userId, me.userId))).toEqual([]);
    expect(await db.select().from(jobs).where(eq(jobs.id, me.jobs.queued))).toEqual([]);

    // Kept: the running job (unlinked), the topic (unlinked), the ledger and events under one tombstone.
    expect(await db.select({ userId: jobs.userId }).from(jobs).where(eq(jobs.id, me.jobs.running))).toEqual([{ userId: null }]);
    expect(await db.select({ createdBy: topics.createdBy }).from(topics).where(eq(topics.id, me.topicId))).toEqual([{ createdBy: null }]);
    const ledger = await db.select().from(creditLedger).where(eq(creditLedger.externalRef, `ls-order:${me.orderId}`));
    expect(ledger).toHaveLength(1);
    const tombstone = ledger[0]?.subjectRef;
    expect(ledger[0]?.userId).toBeNull();
    expect(tombstone).toMatch(/^[0-9a-f-]{36}$/);
    expect(tombstone).not.toBe(me.userId);
    const events = await db.select().from(billingEvents).where(inArray(billingEvents.id, me.events));
    expect(events).toHaveLength(2);
    for (const e of events) {
      const attributes = (e.payload as { data: { attributes: Record<string, unknown> } }).data.attributes;
      for (const [, , field] of STRIPPED_PAYLOAD_PATHS) expect(attributes).not.toHaveProperty(field);
    }
    const custom = (events.find((e) => e.type === 'order_created')?.payload as { meta: { custom_data: { user_id: string } } }).meta.custom_data;
    expect(custom.user_id).toBe(tombstone);
    expect((events.find((e) => e.type === 'order_created')?.payload as { data: { attributes: { total: number } } }).data.attributes.total).toBe(400);

    // The bystander is untouched.
    expect(await new IdentityAccountData(db).export(other.userId)).toEqual(exportBefore);
    const otherEvent = await db.select().from(billingEvents).where(eq(billingEvents.id, other.events[0] ?? ''));
    expect(JSON.stringify(otherEvent[0]?.payload)).toContain(other.email);

    // Nothing in any table of this schema still holds the learner's id, email or name.
    const schema = testSchema();
    const tables = await client.query<{ table_name: string }>(`select table_name from information_schema.tables where table_schema = $1 and table_type = 'BASE TABLE'`, [schema]);
    const leaks: string[] = [];
    for (const { table_name } of tables.rows) {
      const hit = await client.query<{ n: number }>(
        `select count(*)::int as n from "${schema}"."${table_name}" t where row_to_json(t)::text ilike any (array[$1, $2, $3])`,
        [`%${me.userId}%`, `%${me.email}%`, `%${me.name}%`],
      );
      if ((hit.rows[0]?.n ?? 0) > 0) leaks.push(table_name);
    }
    expect(leaks).toEqual([]);
  });

  it("exports only the learner's own rows, without secrets", async () => {
    const tag = randomUUID().slice(0, 8);
    const me = await seedLearner(db, tag);
    const other = await seedLearner(db, `zz${tag}`);
    const contributors = [new IdentityAccountData(db), new AssessmentAccountData(db), new ProgressAccountData(db), new BillingAccountData(db), new CatalogAccountData(db)];

    const text = JSON.stringify(await Promise.all(contributors.map((c) => c.export(me.userId))));

    expect(text).toContain(me.email);
    expect(text).toContain(`my goal ${tag}`);
    expect(text).not.toContain(other.userId);
    expect(text).not.toContain(other.email);
    for (const secret of ['refreshHash', 'refresh_hash', 'passwordHash', 'password_hash', 'googleSub', 'ipHash', 'ip_hash', 'answerKey']) expect(text).not.toContain(secret);
  });
});
