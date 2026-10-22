import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { type Client } from 'pg';
import { DuplicateUserError } from '../../src/modules/identity/application/ports/user.repository';
import { DrizzleLoginAttemptRepository } from '../../src/modules/identity/infrastructure/drizzle-login-attempt.repository';
import { DrizzleSessionRepository } from '../../src/modules/identity/infrastructure/drizzle-session.repository';
import { DrizzleUserRepository } from '../../src/modules/identity/infrastructure/drizzle-user.repository';
import { loginAttempts, sessions as sessionsTable } from '../../src/shared/db/schema/identity';
import { connectTestClient, testDb, type TestDb } from '../db/connect';

describe('identity repositories (integration)', () => {
  let client: Client;
  let db: TestDb;
  let users: DrizzleUserRepository;
  let sessions: DrizzleSessionRepository;
  let attempts: DrizzleLoginAttemptRepository;

  beforeAll(async () => {
    client = await connectTestClient();
    db = testDb(client);
    users = new DrizzleUserRepository(db);
    sessions = new DrizzleSessionRepository(db);
    attempts = new DrizzleLoginAttemptRepository(db);
  });

  afterAll(async () => {
    await client.end();
  });

  const newUser = (email: string) => ({
    email,
    name: null,
    passwordHash: 'h',
    googleSub: null,
    emailVerified: false,
    roles: ['learner'] as const,
  });

  describe('DrizzleUserRepository', () => {
    it('creates a user with roles and finds it by id and case-insensitive email', async () => {
      const created = await users.create(newUser('repo-ada@example.com'));

      expect(created).toMatchObject({ email: 'repo-ada@example.com', plan: 'free', locale: 'en', roles: ['learner'] });
      await expect(users.findById(created.id)).resolves.toEqual(created);
      await expect(users.findByEmail('REPO-ADA@example.com')).resolves.toEqual(created);
    });

    it('maps a case-variant duplicate email to DuplicateUserError and leaves no orphan rows', async () => {
      await users.create(newUser('repo-dup@example.com'));

      await expect(users.create(newUser('Repo-Dup@Example.com'))).rejects.toBeInstanceOf(DuplicateUserError);
    });

    it('links a Google identity: verifies the email and clears the password', async () => {
      const created = await users.create(newUser('repo-link@example.com'));

      const linked = await users.linkGoogle(created.id, 'google-sub-123');

      expect(linked).toMatchObject({ googleSub: 'google-sub-123', emailVerified: true, passwordHash: null, roles: ['learner'] });
      await expect(users.findByGoogleSub('google-sub-123')).resolves.toMatchObject({ id: created.id });
    });
  });

  describe('DrizzleSessionRepository', () => {
    const session = (userId: string, familyId: string = randomUUID()) => ({
      userId,
      familyId,
      refreshHash: randomUUID(),
      userAgent: 'jest',
      ipHash: 'ip',
      authTime: new Date('2026-10-22T10:00:00Z'),
      expiresAt: new Date(Date.now() + 60_000),
    });

    it('rotates exactly once when two connections race for the same session', async () => {
      const user = await users.create(newUser('repo-race@example.com'));
      const first = await sessions.create(session(user.id));
      const now = new Date();
      // Separate connections, so the two transactions really contend for the row lock.
      const [c1, c2] = await Promise.all([connectTestClient(), connectTestClient()]);

      const results = await Promise.all([
        new DrizzleSessionRepository(testDb(c1)).rotate(first.id, session(user.id, first.familyId), now),
        new DrizzleSessionRepository(testDb(c2)).rotate(first.id, session(user.id, first.familyId), now),
      ]).finally(() => Promise.all([c1.end(), c2.end()]));

      expect(results.filter((r) => r !== null)).toHaveLength(1);
      const winner = results.find((r) => r !== null);
      const [stored] = await db.select().from(sessionsTable).where(eq(sessionsTable.id, first.id));
      expect(stored).toMatchObject({ replacedBy: winner?.id });
      expect(stored?.revokedAt).toBeInstanceOf(Date);
    });

    it('stores and returns the auth time, and finds a session by id', async () => {
      const user = await users.create(newUser('repo-authtime@example.com'));
      const created = await sessions.create(session(user.id));

      await expect(sessions.findById(created.id)).resolves.toMatchObject({ authTime: new Date('2026-10-22T10:00:00Z') });
      await expect(sessions.findById(randomUUID())).resolves.toBeNull();
    });

    it('revokes a whole family without touching other families', async () => {
      const user = await users.create(newUser('repo-family@example.com'));
      const familyA = await sessions.create(session(user.id));
      const familyA2 = await sessions.create(session(user.id, familyA.familyId));
      const familyB = await sessions.create(session(user.id));

      await sessions.revokeFamily(familyA.familyId, new Date());

      const revoked = await db.select().from(sessionsTable).where(eq(sessionsTable.userId, user.id));
      const byId = new Map(revoked.map((r) => [r.id, r.revokedAt]));
      expect(byId.get(familyA.id)).toBeInstanceOf(Date);
      expect(byId.get(familyA2.id)).toBeInstanceOf(Date);
      expect(byId.get(familyB.id)).toBeNull();
    });
  });

  describe('DrizzleLoginAttemptRepository', () => {
    it('returns failures in the window that are newer than the latest success', async () => {
      const email = 'repo-lock@example.com';
      const at = (minutesAgo: number) => new Date(Date.now() - minutesAgo * 60_000);
      await db.insert(loginAttempts).values([
        { email, succeeded: false, createdAt: at(20) },
        { email, succeeded: false, createdAt: at(10) },
        { email, succeeded: true, createdAt: at(8) },
        { email, succeeded: false, createdAt: at(5) },
        { email: 'other@example.com', succeeded: false, createdAt: at(4) },
      ]);
      await attempts.record('REPO-LOCK@example.com', false, null);

      const failures = await attempts.failuresSince(email, at(15));

      expect(failures).toHaveLength(2);
      expect(failures.every((d) => d.getTime() > at(8).getTime())).toBe(true);
    });
  });
});
