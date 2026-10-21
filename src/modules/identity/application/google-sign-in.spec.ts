import { createHash } from 'node:crypto';
import { CompleteGoogleSignIn, OAuthFailedError, StartGoogleSignIn } from './google-sign-in.usecase';
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
    authorizationUrl: ({ state, codeChallenge, nonce }) => `https://google.test/auth?state=${state}&cc=${codeChallenge}&nonce=${nonce}`,
    exchange: (input) => {
      exchanges.push(input);
      return Promise.resolve({ sub: 'g-1', email: 'Ada@Example.com', emailVerified: true, name: 'Ada', ...identity });
    },
  };
  const states = new FakeStates();
  return {
    users,
    sessions,
    exchanges,
    google,
    start: new StartGoogleSignIn(google, states),
    complete: new CompleteGoogleSignIn(google, states, users, sessions, clock.fn, issuer),
  };
}

async function begin(t: ReturnType<typeof setup>) {
  const started = await t.start.execute({ origin: 'https://eduujoy.aindrajaya.my.id', returnTo: '/paths' });
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
    await t.sessions.create({ userId: existing.id, familyId: 'f', refreshHash: 'h:attacker', userAgent: null, ipHash: null, expiresAt: new Date('2027-01-01') });
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
