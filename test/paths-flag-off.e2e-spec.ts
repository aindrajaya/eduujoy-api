import { randomUUID } from 'node:crypto';
import { eq, sql } from 'drizzle-orm';
import request from 'supertest';
import { FakePathDesigner } from '../src/modules/pathing/application/pathing.fakes';
import { PATH_DESIGNER } from '../src/modules/pathing/application/ports/path-designer';
import { AccessTokenService } from '../src/shared/common/auth';
import { AppConfig } from '../src/shared/config';
import { DATABASE, type Database } from '../src/shared/db';
import { creditLedger } from '../src/shared/db/schema/billing';
import { pathRequestReplays, paths } from '../src/shared/db/schema/pathing';
import { createTestApp, type TestApp } from './app';
import { learner, placement, readyPool, topic } from './pathing/fixtures';

jest.setTimeout(60_000);

const csrf = { Origin: 'http://localhost:5173', 'X-Requested-With': 'eduujoy' };

/**
 * PATH_BUILDING_ENABLED off (the default; user, 3 Nov 2026): every pathing route answers exactly as it
 * did before A9, when it did not exist. The reference is the router's own answer for an unmatched route
 * with the same method, so the comparison holds whatever the 404 problem body looks like.
 */
describe('paths with PATH_BUILDING_ENABLED off (e2e): pre-A9 behaviour', () => {
  let app: TestApp;
  let db: Database;
  let designer: FakePathDesigner;

  beforeAll(async () => {
    designer = new FakePathDesigner();
    app = await createTestApp((b) => b.overrideProvider(PATH_DESIGNER).useValue(designer));
    db = app.get<Database>(DATABASE);
  });

  afterAll(async () => {
    await app.close();
  });

  const http = () => request(app.getHttpServer());

  type Call = { method: 'get' | 'post' | 'patch'; url: string; body?: object };

  async function send(call: Call, cookie?: string): Promise<request.Response> {
    let req = http()[call.method](call.url).set(csrf).set('Idempotency-Key', `key-${randomUUID()}`);
    if (cookie) req = req.set('Cookie', cookie);
    return call.body ? req.send(call.body) : req;
  }

  /** The response with the request URL and the per-request id replaced, so a route and its unmatched twin compare equal. */
  function shape(res: request.Response, url: string): { status: number; type: string; body: string } {
    return { status: res.status, type: String(res.headers['content-type']), body: JSON.stringify({ ...(res.body as object), requestId: '<id>' }).split(url).join('<url>').split(url.split('?')[0] ?? url).join('<path>') };
  }

  it('is off by default', () => {
    expect(app.get(AppConfig).env.PATH_BUILDING_ENABLED).toBe(false);
  });

  it('answers POST, GET, list and step PATCH exactly as an unmatched route, signed out and signed in, and builds nothing', async () => {
    const userId = await learner(db);
    const cookie = `ej_at=${await app.get(AccessTokenService).sign({ userId, sessionId: randomUUID(), roles: ['learner'], plan: 'free' })}`;
    const topicId = await topic(db);
    await readyPool(db, topicId, 'advanced_beginner', 3);
    await readyPool(db, topicId, 'competent', 4);
    const placementId = await placement(db, userId, topicId);
    const jobsBefore = await db.execute<{ n: number }>(sql`SELECT count(*)::int AS n FROM jobs WHERE type = 'generate-path'`);

    const calls: Call[] = [
      { method: 'post', url: '/v1/paths', body: { placementId, weeklyHours: 5 } },
      { method: 'get', url: '/v1/paths' },
      { method: 'get', url: '/v1/paths?status=active' },
      { method: 'get', url: `/v1/paths/${randomUUID()}` },
      { method: 'patch', url: `/v1/steps/${randomUUID()}`, body: { status: 'completed' } },
    ];
    for (const call of calls) {
      // The same method on a URL no route matches: what pre-A9 main answered for these paths.
      const twin = { ...call, url: call.url.replace(/^\/v1\/(paths|steps)/, '/v1/$1-not-a-route') };
      for (const who of [undefined, cookie]) {
        const res = await send(call, who);
        const ref = await send(twin, who);
        expect(res.status).toBe(404);
        expect(shape(res, call.url)).toEqual(shape(ref, twin.url));
      }
    }

    // No credit reserved, no job enqueued, no path or replay row written, no designer (LLM) call.
    expect(await db.select().from(creditLedger).where(eq(creditLedger.userId, userId))).toEqual([]);
    expect(await db.select().from(paths).where(eq(paths.userId, userId))).toEqual([]);
    expect(await db.select().from(pathRequestReplays).where(eq(pathRequestReplays.userId, userId))).toEqual([]);
    const jobsAfter = await db.execute<{ n: number }>(sql`SELECT count(*)::int AS n FROM jobs WHERE type = 'generate-path'`);
    expect(jobsAfter.rows[0]?.n).toBe(jobsBefore.rows[0]?.n);
    expect(designer.requests).toEqual([]);
  });
});
