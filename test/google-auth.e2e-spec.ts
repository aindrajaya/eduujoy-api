import { randomUUID } from 'node:crypto';
import request, { type Response } from 'supertest';
import { GOOGLE_OAUTH_CLIENT, type GoogleIdentity, type GoogleOAuthClient } from '../src/modules/identity/application/ports/google';
import { createTestApp, type TestApp } from './app';
import { secretKeyPaths } from './leaks';

const csrf = { Origin: 'http://localhost:5173', 'X-Requested-With': 'eduujoy' };

function cookie(res: Response, name: string): string | undefined {
  const raw = res.headers['set-cookie'] as unknown;
  return (Array.isArray(raw) ? (raw as string[]) : []).find((c) => c.startsWith(`${name}=`));
}
const value = (res: Response, name: string): string => cookie(res, name)?.split(';')[0]?.slice(name.length + 1) ?? '';

class FakeGoogle implements GoogleOAuthClient {
  identity: GoogleIdentity = { sub: `g-${randomUUID()}`, email: `g-${randomUUID()}@example.com`, emailVerified: true, name: 'Grace', authTime: null };
  lastReauth: boolean | null = null;
  exchanged: { codeVerifier: string; nonce: string }[] = [];

  authorizationUrl({ state, codeChallenge, nonce, reauth }: { state: string; codeChallenge: string; nonce: string; reauth: boolean }): string {
    this.lastReauth = reauth;
    return `https://accounts.google.com/o/oauth2/v2/auth?state=${state}&code_challenge=${codeChallenge}&nonce=${nonce}`;
  }
  exchange(input: { code: string; codeVerifier: string; nonce: string }): Promise<GoogleIdentity> {
    this.exchanged.push(input);
    return Promise.resolve(this.identity);
  }
}

describe('Google OAuth (e2e)', () => {
  let app: TestApp;
  let google: FakeGoogle;

  beforeEach(async () => {
    google = new FakeGoogle();
    app = await createTestApp((builder) => builder.overrideProvider(GOOGLE_OAUTH_CLIENT).useValue(google));
  });

  afterEach(async () => {
    await app.close();
  });

  const http = () => request(app.getHttpServer());

  async function start(query = '?returnTo=/paths', referer?: string) {
    const req = http().get(`/v1/auth/google${query}`);
    const res = await (referer ? req.set('Referer', referer) : req).expect(302);
    const location = new URL(res.headers.location as string);
    return { res, state: location.searchParams.get('state') ?? '', oauthCookie: value(res, 'ej_oauth') };
  }

  const callback = (params: string, oauthCookie: string) =>
    http().get(`/v1/auth/google/callback?${params}`).set('Cookie', `ej_oauth=${oauthCookie}`).expect(302);

  it('starts with a redirect to Google and a short-lived, path-scoped state cookie', async () => {
    const { res, state } = await start();

    expect((res.headers.location as string).startsWith('https://accounts.google.com/o/oauth2/v2/auth?')).toBe(true);
    expect(state).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(cookie(res, 'ej_oauth')).toMatch(/Max-Age=600; Path=\/v1\/auth\/google; .*HttpOnly; Secure; SameSite=Lax/);
  });

  it('signs in on callback: session cookies set, state cookie cleared, redirect to returnTo', async () => {
    const { state, oauthCookie } = await start('?returnTo=/paths?tab=active');

    const res = await callback(`code=abc&state=${state}&scope=openid%20email&authuser=0&prompt=none`, oauthCookie);

    expect(res.headers.location).toBe('http://localhost:5173/paths?tab=active');
    expect(cookie(res, 'ej_oauth')).toMatch(/ej_oauth=;/);
    const me = await http().get('/v1/auth/me').set('Cookie', `ej_at=${value(res, 'ej_at')}`).expect(200);
    expect((me.body as { user: { email: string } }).user.email).toBe(google.identity.email);
    expect(secretKeyPaths(me.body)).toEqual([]);
    expect(JSON.stringify(me.body)).not.toContain(google.identity.sub);
    expect(google.exchanged[0]?.codeVerifier).toMatch(/^[A-Za-z0-9_-]{64}$/);
  });

  it('returns to an allow-listed origin taken from the Referer, and ignores foreign ones', async () => {
    const staging = await start('', 'https://eduujoy.aindrajaya.my.id/start');
    const fromStaging = await callback(`code=abc&state=${staging.state}`, staging.oauthCookie);
    expect(fromStaging.headers.location).toBe('https://eduujoy.aindrajaya.my.id/today');

    google.identity = { ...google.identity, sub: `g-${randomUUID()}`, email: `g-${randomUUID()}@example.com` };
    const evil = await start('', 'https://evil.example/phish');
    const fromEvil = await callback(`code=abc&state=${evil.state}`, evil.oauthCookie);
    expect(fromEvil.headers.location).toBe('http://localhost:5173/today');
  });

  describe('reauth (contract 0.8.0)', () => {
    const csrf = { Origin: 'http://localhost:5173', 'X-Requested-With': 'eduujoy' };
    const signIn = async (authTime: number | null) => {
      google.identity = { ...google.identity, authTime };
      const { state, oauthCookie } = await start('?returnTo=/account&reauth=true');
      const res = await callback(`code=abc&state=${state}`, oauthCookie);
      return value(res, 'ej_at');
    };
    const del = (access: string) => http().delete('/v1/me').set(csrf).set('Cookie', `ej_at=${access}`);

    it('asks Google for a fresh sign-in only when reauth=true, and rejects a malformed flag', async () => {
      await start('?reauth=true');
      expect(google.lastReauth).toBe(true);
      await start('?reauth=false');
      expect(google.lastReauth).toBe(false);
      await start('');
      expect(google.lastReauth).toBe(false);
      await http().get('/v1/auth/google?reauth=yes').expect(400);
    });

    it('lets DELETE /v1/me through after a fresh Google re-authentication', async () => {
      const access = await signIn(Math.floor(Date.now() / 1000) - 30);
      await del(access).expect(204);
    });

    it.each([
      ['stale', () => Math.floor(Date.now() / 1000) - 11 * 60],
      ['missing', () => null],
      ['far-future', () => Math.floor(Date.now() / 1000) + 3600],
    ])('signs in with a %s auth_time, but deletion still asks again', async (_label, authTime) => {
      const access = await signIn(authTime());
      await http().get('/v1/auth/me').set('Cookie', `ej_at=${access}`).expect(200);
      const res = await del(access).expect(401);
      expect((res.body as { code: string }).code).toBe('REAUTH_REQUIRED');
    });
  });

  it('rejects a mismatched state with ?error=oauth_state and sets no session', async () => {
    const { oauthCookie } = await start();

    const res = await callback('code=abc&state=forged', oauthCookie);

    expect(res.headers.location).toBe('http://localhost:5173/?error=oauth_state');
    expect(value(res, 'ej_at')).toBe('');
    expect(google.exchanged).toHaveLength(0);
  });

  it('maps a denied consent to ?error=oauth_denied', async () => {
    const { state, oauthCookie } = await start();

    const res = await callback(`error=access_denied&state=${state}`, oauthCookie);

    expect(res.headers.location).toBe('http://localhost:5173/?error=oauth_denied');
  });

  it.each([
    '//evil.example',
    '//evil.example/today',
    '/\\evil.example',
    '/a\\b',
    'https://evil.example',
    'javascript:alert(1)',
    'paths',
    '/\t/evil.example',
    '/today\r\nSet-Cookie: x=y',
    '/today\u0000',
    '',
  ])('never redirects to returnTo=%j; falls back to /today', async (returnTo) => {
    const { state, oauthCookie } = await start(`?returnTo=${encodeURIComponent(returnTo)}`);

    const res = await callback(`code=abc&state=${state}`, oauthCookie);

    expect(res.headers.location).toBe('http://localhost:5173/today');
  });

  it('falls back to /today when returnTo is repeated', async () => {
    const { state, oauthCookie } = await start('?returnTo=/a&returnTo=//evil.example');

    const res = await callback(`code=abc&state=${state}`, oauthCookie);

    expect(res.headers.location).toBe('http://localhost:5173/today');
  });

  it('defaults to /today without returnTo', async () => {
    const { state, oauthCookie } = await start('');

    const res = await callback(`code=abc&state=${state}`, oauthCookie);

    expect(res.headers.location).toBe('http://localhost:5173/today');
  });

  it('links an existing password account by verified email and disables its password', async () => {
    const email = `link-${randomUUID()}@example.com`;
    const password = 'correct horse battery';
    const registered = await http().post('/v1/auth/register').set(csrf).send({ email, password }).expect(201);
    google.identity = { ...google.identity, email: email.toUpperCase() };
    const { state, oauthCookie } = await start();

    const res = await callback(`code=abc&state=${state}`, oauthCookie);

    expect(res.headers.location).toBe('http://localhost:5173/paths');
    const me = await http().get('/v1/auth/me').set('Cookie', `ej_at=${value(res, 'ej_at')}`).expect(200);
    expect((me.body as { user: { id: string } }).user.id).toBe((registered.body as { user: { id: string } }).user.id);
    await http().post('/v1/auth/login').set(csrf).send({ email, password }).expect(401);
    await http().post('/v1/auth/refresh').set(csrf).set('Cookie', `ej_rt=${value(registered, 'ej_rt')}`).expect(401);
  });
});
