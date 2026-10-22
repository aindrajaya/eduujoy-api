import { createHash } from 'node:crypto';
import { AUTH_TIME_SKEW_MS, CompleteGoogleSignIn, OAuthFailedError, reauthTime, REAUTH_FRESH_MS, StartGoogleSignIn, UNVERIFIED_AUTH_TIME } from './google-sign-in.usecase';
import { fakeHasher, FakeSessions, FakeUsers, TestClock, testIssuer } from './identity.fakes';
import { type GoogleIdentity, type GoogleOAuthClient, type OAuthState, type OAuthStateStore } from './ports/google';

const meta = { userAgent: 'jest', ip: '203.0.113.7' };

class FakeStates implements OAuthStateStore {
  seal(state: OAuthState): Promise<string> {
    return Promise.resolve(JSON.stringify(state));
  }
  open(sealed: string): Promise<OAuthState | null> {
    try {
      return Promise.resolve(JSON.parse(sealed) as OAuthState);
    } catch {
      return Promise.resolve(null);
    }
  }
}

function setup(identity: Partial<GoogleIdentity> = {}) {
  const clock = new TestClock();
  const users = new FakeUsers();
  const sessions = new FakeSessions();
  const { issuer } = testIssuer(sessions, clock);
  const exchanges: { code: string; codeVerifier: string; nonce: string }[] = [];
  const google: GoogleOAuthClient = {
    authorizationUrl: ({ state, codeChallenge, nonce, reauth }) => `https://google.test/auth?state=${state}&cc=${codeChallenge}&nonce=${nonce}&reauth=${String(reauth)}`,
    exchange: (input) => {
      exchanges.push(input);
      return Promise.resolve({ sub: 'g-1', email: 'Ada@Example.com', emailVerified: true, name: 'Ada', authTime: null, ...identity });
    },
  };
  const states = new FakeStates();
  return {
    clock,
    users,
    sessions,
    exchanges,
    google,
    start: new StartGoogleSignIn(google, states),
    complete: new CompleteGoogleSignIn(google, states, users, sessions, clock.fn, issuer),
  };
}

async function begin(t: ReturnType<typeof setup>, reauth = false) {
  const started = await t.start.execute({ origin: 'https://eduujoy.aindrajaya.my.id', returnTo: '/paths', reauth });
  const saved = JSON.parse(started.sealedState) as OAuthState;
  return { started, saved };
}

describe('StartGoogleSignIn', () => {
  it('uses an S256 challenge of a random verifier, plus fresh state and nonce', async () => {
    const t = setup();
    const { started, saved } = await begin(t);
    const url = new URL(started.redirectUrl);

    expect(url.searchParams.get('cc')).toBe(createHash('sha256').update(saved.codeVerifier).digest('base64url'));
    expect(url.searchParams.get('state')).toBe(saved.state);
    expect(saved.codeVerifier).toMatch(/^[A-Za-z0-9_-]{64}$/);
    expect(saved.state).not.toBe((await begin(t)).saved.state);
  });
});

describe('CompleteGoogleSignIn', () => {
  it('creates a verified, password-less learner on first sign-in and redirects to returnTo', async () => {
    const t = setup();
    const { started, saved } = await begin(t);

    const result = await t.complete.execute({ code: 'c', state: saved.state, sealedState: started.sealedState }, meta);

    expect(result.redirectTo).toBe('https://eduujoy.aindrajaya.my.id/paths');
    expect(result.session.user).toMatchObject({ email: 'ada@example.com', googleSub: 'g-1', emailVerified: true, passwordHash: null, roles: ['learner'] });
    expect(t.exchanges).toEqual([{ code: 'c', codeVerifier: saved.codeVerifier, nonce: saved.nonce }]);
  });

  it('reuses the account on later sign-ins by Google subject', async () => {
    const t = setup();
    const first = await begin(t);
    const a = await t.complete.execute({ code: 'c', state: first.saved.state, sealedState: first.started.sealedState }, meta);
    const second = await begin(t);

    const b = await t.complete.execute({ code: 'c', state: second.saved.state, sealedState: second.started.sealedState }, meta);

    expect(b.session.user.id).toBe(a.session.user.id);
    expect(t.users.rows.size).toBe(1);
  });

  it('links an existing password account by verified email, clearing the password and its sessions', async () => {
    const t = setup();
    const existing = await t.users.create({ email: 'ada@example.com', name: null, passwordHash: await fakeHasher.hash('attacker-set password'), googleSub: null, emailVerified: false, roles: ['learner'] });
    await t.sessions.create({ userId: existing.id, familyId: 'f', refreshHash: 'h:attacker', userAgent: null, ipHash: null, authTime: new Date(), expiresAt: new Date('2027-01-01') });
    const { started, saved } = await begin(t);

    const result = await t.complete.execute({ code: 'c', state: saved.state, sealedState: started.sealedState }, meta);

    expect(result.session.user).toMatchObject({ id: existing.id, googleSub: 'g-1', emailVerified: true, passwordHash: null });
    const attacker = [...t.sessions.rows.values()].find((s) => s.refreshHash === 'h:attacker');
    expect(attacker?.revokedAt).not.toBeNull();
  });

  it.each([
    ['a missing state cookie', (s: string) => ({ code: 'c', state: s })],
    ['a mismatched state', (_s: string, sealed: string) => ({ code: 'c', state: 'other', sealedState: sealed })],
    ['a tampered state cookie', (s: string) => ({ code: 'c', state: s, sealedState: 'garbage' })],
  ])('rejects %s as oauth_state without calling Google', async (_label, input) => {
    const t = setup();
    const { started, saved } = await begin(t);

    await expect(t.complete.execute(input(saved.state, started.sealedState), meta)).rejects.toMatchObject({ code: 'oauth_state' });
    expect(t.exchanges).toHaveLength(0);
  });

  it('maps a denied consent, a failed exchange and an unverified email to redirect codes on the saved origin', async () => {
    const denied = setup();
    const d = await begin(denied);
    await expect(denied.complete.execute({ error: 'access_denied', state: d.saved.state, sealedState: d.started.sealedState }, meta)).rejects.toMatchObject({ code: 'oauth_denied', origin: 'https://eduujoy.aindrajaya.my.id' });

    const failing = setup();
    failing.google.exchange = () => Promise.reject(new Error('invalid_grant'));
    const f = await begin(failing);
    await expect(failing.complete.execute({ code: 'c', state: f.saved.state, sealedState: f.started.sealedState }, meta)).rejects.toMatchObject({ code: 'oauth_failed' });

    const unverified = setup({ emailVerified: false });
    const u = await begin(unverified);
    await expect(unverified.complete.execute({ code: 'c', state: u.saved.state, sealedState: u.started.sealedState }, meta)).rejects.toBeInstanceOf(OAuthFailedError);
    expect(unverified.users.rows.size).toBe(0);
  });
});

describe('Google re-authentication (contract 0.8.0)', () => {
  const now = new Date('2026-10-22T12:00:00Z');
  const secs = (ms: number) => Math.floor(ms / 1000);

  it('counts auth_time only when it is a recent integer, allowing a small skew', () => {
    expect(reauthTime(secs(now.getTime() - 60_000), now)).toEqual(new Date(now.getTime() - 60_000));
    expect(reauthTime(secs(now.getTime() - REAUTH_FRESH_MS + 1000), now).getTime()).toBeGreaterThan(0);
    // Stale, missing, non-integer and far in the future: not fresh.
    expect(reauthTime(secs(now.getTime() - REAUTH_FRESH_MS - 1000), now)).toEqual(UNVERIFIED_AUTH_TIME);
    expect(reauthTime(null, now)).toEqual(UNVERIFIED_AUTH_TIME);
    expect(reauthTime(1.5, now)).toEqual(UNVERIFIED_AUTH_TIME);
    expect(reauthTime(secs(now.getTime() + AUTH_TIME_SKEW_MS + 5000), now)).toEqual(UNVERIFIED_AUTH_TIME);
    // Slightly ahead of our clock (within the skew) is clamped to now.
    expect(reauthTime(secs(now.getTime() + 10_000), now)).toEqual(now);
  });

  it('asks Google for a fresh sign-in and seals the flag in the state', async () => {
    const t = setup();
    const { started, saved } = await begin(t, true);

    expect(new URL(started.redirectUrl).searchParams.get('reauth')).toBe('true');
    expect(saved.reauth).toBe(true);
    expect((await begin(t)).saved.reauth).toBe(false);
  });

  it.each([
    ['fresh', -60_000, 'verified'],
    ['stale', -(REAUTH_FRESH_MS + 60_000), 'epoch'],
    ['missing', null, 'epoch'],
  ] as const)('sets the session auth time from a %s auth_time', async (_label, offset, expected) => {
    const t = setup();
    const authTime = offset === null ? null : secs(t.clock.now.getTime() + offset);
    const google = setup({ authTime });
    const { started, saved } = await begin(google, true);

    await google.complete.execute({ code: 'c', state: saved.state, sealedState: started.sealedState }, meta);

    const [session] = [...google.sessions.rows.values()];
    const want = expected === 'verified' ? new Date((authTime ?? 0) * 1000) : UNVERIFIED_AUTH_TIME;
    expect(session?.authTime).toEqual(want);
  });

  it('never counts a normal Google sign-in as fresh, even with a recent auth_time', async () => {
    const t = setup();
    const google = setup({ authTime: Math.floor(t.clock.now.getTime() / 1000) - 30 });
    const { started, saved } = await begin(google);

    await google.complete.execute({ code: 'c', state: saved.state, sealedState: started.sealedState }, meta);

    expect([...google.sessions.rows.values()][0]?.authTime).toEqual(UNVERIFIED_AUTH_TIME);
  });
});

