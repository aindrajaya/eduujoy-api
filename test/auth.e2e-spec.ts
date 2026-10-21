import { randomUUID } from 'node:crypto';
import { eq, sql } from 'drizzle-orm';
import request, { type Response } from 'supertest';
import { AccessTokenService } from '../src/shared/common/auth';
import { DATABASE, type Database } from '../src/shared/db';
import { loginAttempts, sessions } from '../src/shared/db/schema/identity';
import { createTestApp, type TestApp } from './app';

const ORIGIN = 'http://localhost:5173';
const csrf = { Origin: ORIGIN, 'X-Requested-With': 'eduujoy' };
const password = 'correct horse battery';

function setCookies(res: Response): string[] {
  const raw = res.headers['set-cookie'] as unknown;
  return Array.isArray(raw) ? (raw as string[]) : [];
}

function cookie(res: Response, name: string): string | undefined {
  return setCookies(res).find((c) => c.startsWith(`${name}=`));
}

function cookieValue(res: Response, name: string): string {
  return cookie(res, name)?.split(';')[0]?.slice(name.length + 1) ?? '';
}

interface ProblemJson {
  code: string;
  title: string;
  errors?: { field: string }[];
}
interface MeJson {
  user: { id: string; email: string };
}
const problem = (res: Response): ProblemJson => res.body as ProblemJson;
const me = (res: Response): MeJson => res.body as MeJson;

const email = (): string => `e2e-${randomUUID()}@example.com`;

describe('auth (e2e)', () => {
  let app: TestApp;
  let db: Database;

  beforeEach(async () => {
    app = await createTestApp(); // fresh app = fresh in-memory throttle counters per test
    db = app.get<Database>(DATABASE);
  });

  afterEach(async () => {
    await app.close();
  });

  const http = () => request(app.getHttpServer());
  const register = (address: string) => http().post('/v1/auth/register').set(csrf).send({ email: address, password });
  const login = (address: string, pw = password) => http().post('/v1/auth/login').set(csrf).send({ email: address, password: pw });

  describe('register', () => {
    it('creates the account, returns Me and sets host-only Secure HttpOnly SameSite=Lax cookies', async () => {
      const address = email();
      const res = await register(address).expect(201);

      expect(res.body).toEqual({
        user: { id: expect.any(String) as string, email: address, name: null, locale: 'en', weeklyHoursDefault: null },
        roles: ['learner'],
        plan: 'free',
        quota: { monthlyPaths: 1, usedPaths: 0, credits: 0, periodEnd: expect.any(String) as string },
      });
      const access = cookie(res, 'ej_at') ?? '';
      const refresh = cookie(res, 'ej_rt') ?? '';
      expect(access).toMatch(/; Max-Age=900; Path=\/; .*HttpOnly; Secure; SameSite=Lax/);
      expect(refresh).toMatch(/; Max-Age=2592000; Path=\/v1\/auth; .*HttpOnly; Secure; SameSite=Lax/);
      expect(`${access}${refresh}`).not.toMatch(/Domain=/i);
    });

    it('returns 409 EMAIL_TAKEN for an existing email in any case', async () => {
      const address = email();
      await register(address).expect(201);

      const res = await register(address.toUpperCase()).expect(409);

      expect(res.body).toMatchObject({ code: 'EMAIL_TAKEN', status: 409 });
    });

    it('returns 400 with field errors for invalid input and unknown fields', async () => {
      const res = await http()
        .post('/v1/auth/register')
        .set(csrf)
        .send({ email: 'not-an-email', password: 'short', admin: true })
        .expect(400)
        .expect('Content-Type', /application\/problem\+json/);

      expect(problem(res).code).toBe('VALIDATION_FAILED');
      const fields = (problem(res).errors ?? []).map((e) => e.field).sort();
      expect(fields).toEqual(['admin', 'email', 'password']);
    });

    it.each([
      ['no X-Requested-With', { Origin: ORIGIN }],
      ['a foreign Origin', { Origin: 'https://evil.example', 'X-Requested-With': 'eduujoy' }],
      ['no Origin', { 'X-Requested-With': 'eduujoy' }],
    ])('rejects a request with %s as CSRF_REJECTED', async (_label, headers) => {
      const res = await http().post('/v1/auth/register').set(headers).send({ email: email(), password }).expect(403);

      expect(problem(res).code).toBe('CSRF_REJECTED');
    });
  });

  describe('login and me', () => {
    it('signs in with the right password and serves /me from the access cookie', async () => {
      const address = email();
      await register(address).expect(201);

      const res = await login(address.toUpperCase()).expect(200);
      const meRes = await http().get('/v1/auth/me').set('Cookie', `ej_at=${cookieValue(res, 'ej_at')}`).expect(200);

      expect(me(meRes).user.email).toBe(address);
    });

    it('returns the same 401 for a wrong password and an unknown email', async () => {
      const address = email();
      await register(address).expect(201);

      const wrong = await login(address, 'wrong horse battery').expect(401);
      const unknown = await login(email()).expect(401);

      expect(wrong.body).toMatchObject({ code: 'UNAUTHENTICATED', title: 'Invalid email or password' });
      expect(problem(unknown).title).toBe(problem(wrong).title);
    });

    it('rejects /me without a valid access cookie', async () => {
      await http().get('/v1/auth/me').expect(401);
      const res = await http().get('/v1/auth/me').set('Cookie', 'ej_at=forged.token.value').expect(401);

      expect(problem(res).code).toBe('UNAUTHENTICATED');
    });

    it('throttles the 6th credential attempt in a minute with 429 and Retry-After', async () => {
      for (let i = 0; i < 5; i += 1) await login(email()).expect(401);

      const res = await login(email()).expect(429);

      expect(problem(res).code).toBe('RATE_LIMITED');
      expect(Number(res.headers['retry-after'])).toBeGreaterThan(0);
    });

    it('locks the account after 10 failures in 15 minutes, even for the right password', async () => {
      const address = email();
      await register(address).expect(201);
      await db.insert(loginAttempts).values(
        Array.from({ length: 10 }, (_, i) => ({ email: address, succeeded: false, createdAt: new Date(Date.now() - (i + 1) * 1000) })),
      );

      const res = await login(address).expect(429);

      expect(res.body).toMatchObject({ code: 'RATE_LIMITED', title: 'Too many failed sign-in attempts' });
      expect(Number(res.headers['retry-after'])).toBeGreaterThan(800);
    });
  });

  describe('refresh and logout', () => {
    const refresh = (token: string) => http().post('/v1/auth/refresh').set(csrf).set('Cookie', `ej_rt=${token}`);

    it('rotates the refresh token and issues a new access cookie', async () => {
      const signedIn = await register(email()).expect(201);
      const first = cookieValue(signedIn, 'ej_rt');

      const res = await refresh(first).expect(204);

      expect(cookieValue(res, 'ej_rt')).not.toBe(first);
      expect(cookieValue(res, 'ej_at')).not.toBe('');
      await http().get('/v1/auth/me').set('Cookie', `ej_at=${cookieValue(res, 'ej_at')}`).expect(200);
    });

    it('detects reuse of a rotated token: 401 SESSION_REVOKED, the family is revoked, cookies are cleared', async () => {
      const signedIn = await register(email()).expect(201);
      const first = cookieValue(signedIn, 'ej_rt');
      const rotated = await refresh(first).expect(204);
      const second = cookieValue(rotated, 'ej_rt');
      // Move the rotation outside the 10 s grace window instead of sleeping.
      await db.update(sessions).set({ revokedAt: sql`now() - interval '1 minute'` }).where(sql`${sessions.replacedBy} is not null`);

      const reuse = await refresh(first).expect(401);

      expect(problem(reuse).code).toBe('SESSION_REVOKED');
      expect(cookie(reuse, 'ej_rt')).toMatch(/ej_rt=;.*Expires=Thu, 01 Jan 1970/);
      const after = await refresh(second).expect(401);
      expect(problem(after).code).toBe('UNAUTHENTICATED');
    });

    it('answers a concurrent refresh inside the grace window with 409 and no Set-Cookie', async () => {
      const signedIn = await register(email()).expect(201);
      const original = cookieValue(signedIn, 'ej_rt');

      const first = await refresh(original).expect(204);
      const second = await refresh(original).expect(409).expect('Content-Type', /application\/problem\+json/);

      expect(problem(second).code).toBe('REFRESH_CONCURRENT');
      expect(second.headers['set-cookie']).toBeUndefined();
      // The winner's cookies stay valid.
      await http().get('/v1/auth/me').set('Cookie', `ej_at=${cookieValue(first, 'ej_at')}`).expect(200);
      await refresh(cookieValue(first, 'ej_rt')).expect(204);
    });

    it('rejects refresh without CSRF headers or without a cookie', async () => {
      await http().post('/v1/auth/refresh').set('Cookie', 'ej_rt=x').expect(403);
      await http().post('/v1/auth/refresh').set(csrf).expect(401);
    });

    it('logs out: 204, both cookies cleared, refresh token revoked', async () => {
      const signedIn = await register(email()).expect(201);
      const cookies = `ej_at=${cookieValue(signedIn, 'ej_at')}; ej_rt=${cookieValue(signedIn, 'ej_rt')}`;

      const res = await http().post('/v1/auth/logout').set(csrf).set('Cookie', cookies).expect(204);

      expect(cookie(res, 'ej_at')).toMatch(/ej_at=;.*Path=\/;/);
      expect(cookie(res, 'ej_rt')).toMatch(/ej_rt=;.*Path=\/v1\/auth;/);
      await refresh(cookieValue(signedIn, 'ej_rt')).expect(401);
      const [row] = await db.select().from(sessions).where(eq(sessions.userId, me(signedIn).user.id));
      expect(row?.revokedAt).toBeInstanceOf(Date);
    });

    it('logs out with an expired access token: 204, session revoked, old refresh token dead', async () => {
      const signedIn = await register(email()).expect(201);
      const expired = await app.get(AccessTokenService).sign(
        { userId: me(signedIn).user.id, sessionId: randomUUID(), roles: ['learner'], plan: 'free' },
        new Date(Date.now() - 16 * 60 * 1000),
      );

      const res = await http()
        .post('/v1/auth/logout')
        .set(csrf)
        .set('Cookie', `ej_at=${expired}; ej_rt=${cookieValue(signedIn, 'ej_rt')}`)
        .expect(204);

      expect(cookie(res, 'ej_at')).toMatch(/ej_at=;/);
      expect(cookie(res, 'ej_rt')).toMatch(/ej_rt=;/);
      const [row] = await db.select().from(sessions).where(eq(sessions.userId, me(signedIn).user.id));
      expect(row?.revokedAt).toBeInstanceOf(Date);
      await refresh(cookieValue(signedIn, 'ej_rt')).expect(401);
    });

    it('always clears both cookies, even without any credentials', async () => {
      const res = await http().post('/v1/auth/logout').set(csrf).expect(204);

      expect(cookie(res, 'ej_at')).toMatch(/ej_at=;/);
      expect(cookie(res, 'ej_rt')).toMatch(/ej_rt=;/);
    });

    it('still requires the CSRF headers to log out', async () => {
      const res = await http().post('/v1/auth/logout').expect(403);

      expect(problem(res).code).toBe('CSRF_REJECTED');
    });
  });
});
