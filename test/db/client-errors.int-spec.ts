import { Client, Pool, type PoolClient } from 'pg';
import { guardConnection } from '../../src/shared/db/cli/guard';
import { guardPool } from '../../src/shared/db/db.module';
import { connectTestClient, testSchema } from './connect';

// A dropped Neon connection makes the pg client emit 'error'; without a listener Node turns it into an
// uncaught exception and the process dies (A8 smoke, 23 Oct 2026: "read ETIMEDOUT" → "Unhandled
// 'error' event", pg/lib/client.js:422). Each case kills the backend from the server side, exactly
// what a dropped connection looks like (FATAL 57P01), and asserts the process survives and recovers.
describe('database client errors (integration)', () => {
  let admin: Client;
  const logged: string[] = [];
  const uncaught: unknown[] = [];
  const onUncaught = (error: unknown): void => {
    uncaught.push(error);
  };

  beforeAll(async () => {
    admin = await connectTestClient();
    process.on('uncaughtException', onUncaught);
  });

  afterAll(async () => {
    process.off('uncaughtException', onUncaught);
    await admin.end();
  });

  const pidOf = async (c: PoolClient | Client): Promise<number> => ((await c.query<{ pid: number }>('select pg_backend_pid() as pid')).rows[0] as { pid: number }).pid;
  const kill = async (pid: number): Promise<void> => {
    await admin.query('select pg_terminate_backend($1)', [pid]);
    await new Promise((resolve) => setTimeout(resolve, 500));
  };
  const appPool = (): Pool => {
    // The app's pool, as DbModule builds it.
    return guardPool(new Pool({ connectionString: process.env['DATABASE_URL'], options: `-c search_path="${testSchema()}",public`, max: 3 }), (m) => logged.push(m));
  };

  it('the app pool survives a killed idle client and keeps serving', async () => {
    const pool = appPool();
    try {
      const c = await pool.connect();
      const pid = await pidOf(c);
      c.release();
      await kill(pid);
      await expect(pool.query('select 1 as ok')).resolves.toMatchObject({ rows: [{ ok: 1 }] });
      expect(uncaught).toEqual([]);
    } finally {
      await pool.end();
    }
  });

  it('the app pool survives a killed checked-out client, and a query killed mid-flight rejects instead of crashing', async () => {
    const pool = appPool();
    try {
      const held = await pool.connect();
      await kill(await pidOf(held));
      // Released the way Drizzle does (no error argument): the pool must not hand the broken client out again.
      held.release();
      const busy = await pool.connect();
      const pid = await pidOf(busy);
      const slow = busy.query('select pg_sleep(5)');
      await kill(pid);
      await expect(slow).rejects.toThrow();
      busy.release();
      for (let i = 0; i < 4; i++) await expect(pool.query('select 1 as ok')).resolves.toMatchObject({ rows: [{ ok: 1 }] });
      expect(uncaught).toEqual([]);
      expect(logged.some((m) => m.startsWith('Database client error:'))).toBe(true);
    } finally {
      await pool.end();
    }
  });

  it('a guarded CLI client logs the drop and rejects, instead of killing the process', async () => {
    const lines: string[] = [];
    const client = guardConnection(new Client({ connectionString: process.env['DATABASE_URL'], options: `-c search_path="${testSchema()}",public` }), 'db:test', (l) => lines.push(l));
    await client.connect();
    try {
      await kill(await pidOf(client));
      await expect(client.query('select 1')).rejects.toThrow();
      expect(uncaught).toEqual([]);
      expect(lines.join('')).toMatch(/^db:test: database connection error: /);
    } finally {
      await client.end().catch(() => undefined);
    }
  });
});

