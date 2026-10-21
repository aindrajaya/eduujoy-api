import { type GetQuotaQuery } from '../../billing/application/get-quota.query';
import { REFRESH_GRACE_MS } from '../domain/refresh-rotation';
import { AccountLockedError, EmailTakenError, InvalidCredentialsError, InvalidPasswordError, SessionInvalidError } from './errors';
import { GetMe } from './get-me.query';
import { FakeAttempts, fakeHasher, fakeSecrets, FakeSessions, FakeUsers, TestClock, testIssuer } from './identity.fakes';
import { LoginWithPassword } from './login.usecase';
import { Logout } from './logout.usecase';
import { RefreshSession } from './refresh.usecase';
import { RegisterUser } from './register.usecase';

const meta = { userAgent: 'jest', ip: '203.0.113.7' };

function setup() {
  const clock = new TestClock();
  const users = new FakeUsers();
  const sessions = new FakeSessions();
  const attempts = new FakeAttempts(clock.fn);
  const { issuer, tokens } = testIssuer(sessions, clock);
  return {
    clock,
    users,
    sessions,
    attempts,
    tokens,
    register: new RegisterUser(users, fakeHasher, issuer),
    login: new LoginWithPassword(users, attempts, fakeHasher, fakeSecrets, clock.fn, issuer),
    refresh: new RefreshSession(sessions, users, fakeSecrets, clock.fn, issuer),
    logout: new Logout(sessions, fakeSecrets, clock.fn),
  };
}

describe('RegisterUser', () => {
  it('creates a learner with a hashed password and starts a session', async () => {
    const t = setup();

    const issued = await t.register.execute({ email: ' Ada@Example.com ', password: 'correct horse', name: ' Ada ' }, meta);

    expect(issued.user).toMatchObject({ email: 'ada@example.com', name: 'Ada', roles: ['learner'], emailVerified: false });
    expect(issued.user.passwordHash).toBe('hashed:correct horse');
    const session = [...t.sessions.rows.values()][0];
    expect(session).toMatchObject({ userId: issued.user.id, refreshHash: `h:${issued.refreshToken}`, ipHash: 'ip:203.0.113.7' });
    await expect(t.tokens.verify(issued.accessToken, t.clock.now)).resolves.toMatchObject({
      userId: issued.user.id,
      sessionId: session?.id,
      roles: ['learner'],
    });
  });

  it('refuses a taken email regardless of case', async () => {
    const t = setup();
    await t.register.execute({ email: 'ada@example.com', password: 'correct horse' }, meta);

    await expect(t.register.execute({ email: 'ADA@example.com', password: 'another one!' }, meta)).rejects.toBeInstanceOf(
      EmailTakenError,
    );
  });

  it('enforces the password policy', async () => {
    await expect(setup().register.execute({ email: 'a@b.co', password: 'short' }, meta)).rejects.toBeInstanceOf(
      InvalidPasswordError,
    );
  });
});

describe('LoginWithPassword', () => {
  it('signs in with the right password and records the success', async () => {
    const t = setup();
    await t.register.execute({ email: 'ada@example.com', password: 'correct horse' }, meta);

    const issued = await t.login.execute({ email: 'ADA@example.com', password: 'correct horse' }, meta);

    expect(issued.user.email).toBe('ada@example.com');
    expect(t.attempts.rows.at(-1)).toMatchObject({ email: 'ada@example.com', succeeded: true });
  });

  it('gives the same error for a wrong password and an unknown email, and burns hash time for the latter', async () => {
    const t = setup();
    await t.register.execute({ email: 'ada@example.com', password: 'correct horse' }, meta);
    const before = fakeHasher.dummyCalls;

    await expect(t.login.execute({ email: 'ada@example.com', password: 'wrong horse!' }, meta)).rejects.toBeInstanceOf(
      InvalidCredentialsError,
    );
    await expect(t.login.execute({ email: 'nobody@example.com', password: 'whatever!!' }, meta)).rejects.toBeInstanceOf(
      InvalidCredentialsError,
    );
    expect(fakeHasher.dummyCalls).toBe(before + 1);
  });

  it('locks after 10 failures in 15 minutes, even with the right password, then unlocks', async () => {
    const t = setup();
    await t.register.execute({ email: 'ada@example.com', password: 'correct horse' }, meta);
    for (let i = 0; i < 10; i += 1) {
      await expect(t.login.execute({ email: 'ada@example.com', password: 'wrong horse!' }, meta)).rejects.toBeInstanceOf(
        InvalidCredentialsError,
      );
      t.clock.advance(1000);
    }

    const locked = t.login.execute({ email: 'ada@example.com', password: 'correct horse' }, meta);
    await expect(locked).rejects.toBeInstanceOf(AccountLockedError);
    await expect(locked).rejects.toMatchObject({ retryAfterSeconds: 15 * 60 - 10 });

    t.clock.advance(15 * 60 * 1000);
    await expect(t.login.execute({ email: 'ada@example.com', password: 'correct horse' }, meta)).resolves.toBeDefined();
  });

  it('rejects password login for an account that has no password (Google-only)', async () => {
    const t = setup();
    await t.users.create({ email: 'g@example.com', name: null, passwordHash: null, googleSub: 'sub-1', emailVerified: true, roles: ['learner'] });

    await expect(t.login.execute({ email: 'g@example.com', password: 'anything!!' }, meta)).rejects.toBeInstanceOf(
      InvalidCredentialsError,
    );
  });
});

describe('RefreshSession', () => {
  async function signedIn() {
    const t = setup();
    const issued = await t.register.execute({ email: 'ada@example.com', password: 'correct horse' }, meta);
    return { ...t, issued };
  }

  it('rotates the refresh token within the same family', async () => {
    const t = await signedIn();

    const next = await t.refresh.execute(t.issued.refreshToken, meta);

    expect(next.refreshToken).not.toBe(t.issued.refreshToken);
    const rows = [...t.sessions.rows.values()];
    expect(rows).toHaveLength(2);
    expect(new Set(rows.map((r) => r.familyId)).size).toBe(1);
    expect(rows[0]).toMatchObject({ replacedBy: rows[1]?.id, revokedAt: t.clock.now });
  });

  it('revokes the whole family when a rotated token is reused after the grace window', async () => {
    const t = await signedIn();
    const second = await t.refresh.execute(t.issued.refreshToken, meta);
    t.clock.advance(REFRESH_GRACE_MS + 1);

    await expect(t.refresh.execute(t.issued.refreshToken, meta)).rejects.toMatchObject({ reason: 'reuse' });
    await expect(t.refresh.execute(second.refreshToken, meta)).rejects.toMatchObject({ reason: 'revoked' });
    expect([...t.sessions.rows.values()].every((r) => r.revokedAt !== null)).toBe(true);
  });

  it('rejects but does not revoke on a concurrent refresh inside the grace window', async () => {
    const t = await signedIn();
    const second = await t.refresh.execute(t.issued.refreshToken, meta);

    await expect(t.refresh.execute(t.issued.refreshToken, meta)).rejects.toMatchObject({ reason: 'concurrent' });
    await expect(t.refresh.execute(second.refreshToken, meta)).resolves.toBeDefined();
  });

  it('rejects missing, unknown and expired tokens', async () => {
    const t = await signedIn();

    await expect(t.refresh.execute(undefined, meta)).rejects.toBeInstanceOf(SessionInvalidError);
    await expect(t.refresh.execute('unknown', meta)).rejects.toMatchObject({ reason: 'missing' });
    t.clock.advance(31 * 24 * 60 * 60 * 1000);
    await expect(t.refresh.execute(t.issued.refreshToken, meta)).rejects.toMatchObject({ reason: 'expired' });
  });
});

describe('Logout', () => {
  it('revokes the session by its refresh cookie without an access token', async () => {
    const t = setup();
    const issued = await t.register.execute({ email: 'ada@example.com', password: 'correct horse' }, meta);

    await t.logout.execute({ refreshToken: issued.refreshToken });

    await expect(t.refresh.execute(issued.refreshToken, meta)).rejects.toMatchObject({ reason: 'revoked' });
  });

  it('revokes the access token session when only the access token is present', async () => {
    const t = setup();
    const issued = await t.register.execute({ email: 'ada@example.com', password: 'correct horse' }, meta);
    const claims = await t.tokens.verify(issued.accessToken, t.clock.now);

    await t.logout.execute({ sessionId: claims?.sessionId ?? '' });

    await expect(t.refresh.execute(issued.refreshToken, meta)).rejects.toMatchObject({ reason: 'revoked' });
  });

  it('is a no-op for an unknown refresh token or no credentials at all', async () => {
    const t = setup();
    const issued = await t.register.execute({ email: 'ada@example.com', password: 'correct horse' }, meta);

    await expect(t.logout.execute({ refreshToken: 'unknown' })).resolves.toBeUndefined();
    await expect(t.logout.execute({})).resolves.toBeUndefined();
    await expect(t.refresh.execute(issued.refreshToken, meta)).resolves.toBeDefined();
  });
});

describe('GetMe', () => {
  it('combines the user, roles and billing quota', async () => {
    const t = setup();
    const issued = await t.register.execute({ email: 'ada@example.com', password: 'correct horse' }, meta);
    const periodEnd = new Date('2026-11-01T00:00:00Z');
    const quota = { execute: jest.fn().mockResolvedValue({ plan: 'free', monthlyPaths: 1, usedPaths: 0, credits: 0, periodEnd }) };

    const me = await new GetMe(t.users, quota as unknown as GetQuotaQuery).execute(issued.user.id);

    expect(me).toEqual({
      user: { id: issued.user.id, email: 'ada@example.com', name: null, locale: 'en', weeklyHoursDefault: null },
      roles: ['learner'],
      plan: 'free',
      quota: { monthlyPaths: 1, usedPaths: 0, credits: 0, periodEnd },
    });
  });
});
