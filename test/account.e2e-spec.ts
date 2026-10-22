import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import request, { type Response } from 'supertest';
import { DATABASE, type Database } from '../src/shared/db';
import { sessions, users } from '../src/shared/db/schema/identity';
import { createTestApp, type TestApp } from './app';
import { secretKeyPaths } from './leaks';

const ORIGIN = 'http://localhost:5173';
const csrf = { Origin: ORIGIN, 'X-Requested-With': 'eduujoy' };
const password = 'correct horse battery';

function setCookies(res: Response): string[] {
  const raw = res.headers['set-cookie'] as unknown;
  return Array.isArray(raw) ? (raw as string[]) : [];
}
const cookieValue = (res: Response, name: string) => setCookies(res).find((c) => c.startsWith(`${name}=`))?.split(';')[0]?.slice(name.length + 1) ?? '';

describe('account export and deletion (e2e, contract 0.6.0/0.7.1)', () => {
  let app: TestApp;
  let db: Database;
  let ip = 0;

  beforeAll(async () => {
    app = await createTestApp();
    db = app.get<Database>(DATABASE);
  });

  afterAll(async () => {
    await app.close();
  });

  // Credential routes are throttled per IP: each learner signs in from its own address.
  const http = (addr: string) => {
    const agent = request(app.getHttpServer());
    const withIp = <T extends { set: (k: string, v: string) => T }>(r: T) => r.set('X-Forwarded-For', addr);
    return {
      get: (path: string) => withIp(agent.get(path)),
      post: (path: string) => withIp(agent.post(path)),
      delete: (path: string) => withIp(agent.delete(path)),
    };
  };

  async function registered() {
    const addr = `10.13.${Math.floor(++ip / 250)}.${ip % 250}`;
    const email = `account-${randomUUID()}@example.com`;
    const res = await http(addr).post('/v1/auth/register').set(csrf).send({ email, password, name: 'Ada Account' }).expect(201);
    const [user] = await db.select().from(users).where(eq(users.email, email));
    return { addr, email, userId: user?.id ?? '', access: cookieValue(res, 'ej_at'), refresh: cookieValue(res, 'ej_rt') };
  }
  const cookies = (access: string, refresh?: string) => [`ej_at=${access}`, ...(refresh ? [`ej_rt=${refresh}`] : [])].join('; ');

  it("exports my data as a no-store JSON attachment the UI can name, and nobody else's", async () => {
    const me = await registered();
    const other = await registered();

    const res = await http(me.addr).get('/v1/me/export').set('Origin', ORIGIN).set('Cookie', cookies(me.access)).expect(200);

    expect(res.headers['content-type']).toMatch(/^application\/json/);
    expect(res.headers['content-disposition']).toMatch(/^attachment; filename="eduujoy-export-\d{4}-\d{2}-\d{2}\.json"$/);
    expect(res.headers['cache-control']).toBe('no-store');
    expect(res.headers['access-control-expose-headers']).toContain('Content-Disposition');
    const body = res.body as { format: string; account: { user: { email: string; name: string } } };
    expect(body).toMatchObject({ format: 'eduujoy-export-v1', account: { user: { email: me.email, name: 'Ada Account' } } });
    expect(Object.keys(body).sort()).toEqual(['account', 'assessment', 'billing', 'exportedAt', 'format', 'progress', 'topicsCreated']);
    const text = JSON.stringify(body);
    expect(text).not.toContain(other.email);
    expect(text).not.toContain(other.userId);
    expect(secretKeyPaths(body)).toEqual([]);
    // Secret columns never appear as keys (hasPassword / googleLinked are booleans, by design).
    expect(text).not.toMatch(/hash"|"googleSub"|"password"/i);
    await http(me.addr).get('/v1/me/export').expect(401);
  });

  it('rate-limits exports (5 per hour) with 429 and Retry-After', async () => {
    const me = await registered();
    for (let i = 0; i < 5; i++) await http(me.addr).get('/v1/me/export').set('Cookie', cookies(me.access)).expect(200);

    const limited = await http(me.addr).get('/v1/me/export').set('Cookie', cookies(me.access)).expect(429);

    expect((limited.body as { code: string }).code).toBe('RATE_LIMITED');
    expect(Number(limited.headers['retry-after'])).toBeGreaterThan(0);
  });

  it('asks for a fresh sign-in after 10 minutes; a refresh does not count; a new login does', async () => {
    const me = await registered();
    // The sign-in happened 11 minutes ago.
    await db.update(sessions).set({ authTime: new Date(Date.now() - 11 * 60 * 1000) }).where(eq(sessions.userId, me.userId));

    const stale = await http(me.addr).delete('/v1/me').set(csrf).set('Cookie', cookies(me.access)).expect(401);
    expect((stale.body as { code: string }).code).toBe('REAUTH_REQUIRED');

    const refreshed = await http(me.addr).post('/v1/auth/refresh').set(csrf).set('Cookie', `ej_rt=${me.refresh}`).expect(204);
    const afterRefresh = await http(me.addr).delete('/v1/me').set(csrf).set('Cookie', cookies(cookieValue(refreshed, 'ej_at'))).expect(401);
    expect((afterRefresh.body as { code: string }).code).toBe('REAUTH_REQUIRED');

    const login = await http(me.addr).post('/v1/auth/login').set(csrf).send({ email: me.email, password }).expect(200);
    await http(me.addr).delete('/v1/me').set(csrf).set('Cookie', cookies(cookieValue(login, 'ej_at'))).expect(204);
    expect(await db.select().from(users).where(eq(users.id, me.userId))).toEqual([]);
  });

  it('deletes with CSRF only, clears both cookies, and leaves nothing to sign back in with', async () => {
    const me = await registered();

    await http(me.addr).delete('/v1/me').set('Cookie', cookies(me.access)).expect(403);
    await http(me.addr).delete('/v1/me').set(csrf).expect(401);
    const res = await http(me.addr).delete('/v1/me').set(csrf).set('Cookie', cookies(me.access, me.refresh)).expect(204);

    const cleared = setCookies(res);
    for (const name of ['ej_at', 'ej_rt']) {
      const c = cleared.find((x) => x.startsWith(`${name}=;`));
      expect(c).toBeDefined();
      expect(c).toMatch(/Expires=Thu, 01 Jan 1970/);
      expect(c).toMatch(/HttpOnly/);
    }
    // Every session went with the account: the refresh token is dead, the old access token no longer works.
    expect(await db.select().from(sessions).where(eq(sessions.userId, me.userId))).toEqual([]);
    await http(me.addr).post('/v1/auth/refresh').set(csrf).set('Cookie', `ej_rt=${me.refresh}`).expect(401);
    await http(me.addr).get('/v1/auth/me').set('Cookie', cookies(me.access)).expect(401);
    await http(me.addr).post('/v1/auth/login').set(csrf).send({ email: me.email, password }).expect(401);
    // The deleted-user denylist: the still-unexpired access token is refused on every route at once.
    const withOldToken = cookies(me.access);
    for (const send of [
      () => http(me.addr).get('/v1/me/export').set('Cookie', withOldToken),
      () => http(me.addr).post('/v1/topics/resolve').set(csrf).set('Cookie', withOldToken).send({ text: 'kubernetes' }),
      () => http(me.addr).post('/v1/billing/checkout').set(csrf).set('Cookie', withOldToken).send({ product: 'credit_pack' }),
    ]) {
      const res = await send().expect(401);
      expect((res.body as { code: string }).code).toBe('UNAUTHENTICATED');
    }
  });
});
