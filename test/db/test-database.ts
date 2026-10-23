import { randomBytes } from 'node:crypto';
import { describeTarget, isProdDatabase } from '../../src/shared/db/prod-endpoints';

// Safety rules for the Neon test branch (PRD-API §12): tests never touch the app databases,
// and only ever create or drop schemas named test_<UTC timestamp>_<8 hex>.

const TEST_SCHEMA = /^test_(\d{14})_[0-9a-f]{8}$/;
const STALE_AFTER_MS = 24 * 60 * 60 * 1000;

export class UnsafeTestDatabaseError extends Error {
  override name = 'UnsafeTestDatabaseError';
}

interface DbIdentity {
  host: string;
  database: string;
  pooled: boolean;
}

function identify(url: string): DbIdentity {
  const parsed = new URL(url);
  const pooled = parsed.hostname.includes('-pooler');
  return {
    host: parsed.hostname.replace('-pooler', '').toLowerCase(),
    database: decodeURIComponent(parsed.pathname.replace(/^\//, '')) || 'postgres',
    pooled,
  };
}

export function assertSafeTestDatabase(testUrl: string | undefined, appUrls: (string | undefined)[], env: NodeJS.ProcessEnv = process.env): void {
  if (!testUrl) throw new UnsafeTestDatabaseError('DATABASE_URL_TEST is not set; integration and e2e tests need it.');
  // Tests create schemas and the sweep drops test_* schemas: never on prod, and no override (lead, 23 Oct 2026).
  if (isProdDatabase(testUrl, env['PROD_DATABASE_ENDPOINTS'])) {
    throw new UnsafeTestDatabaseError(`DATABASE_URL_TEST is the prod database (${describeTarget(testUrl).endpoint}); refusing to run tests or the schema sweep there.`);
  }
  const test = identify(testUrl);
  if (test.pooled) {
    throw new UnsafeTestDatabaseError('DATABASE_URL_TEST is a pooled connection; use the direct Neon connection string.');
  }
  for (const appUrl of appUrls) {
    if (!appUrl) continue;
    const app = identify(appUrl);
    if (appUrl === testUrl || (app.host === test.host && app.database === test.database)) {
      throw new UnsafeTestDatabaseError(
        'DATABASE_URL_TEST points at the same database as DATABASE_URL or DATABASE_URL_DIRECT; refusing to run tests.',
      );
    }
  }
}

function timestamp(now: Date): string {
  return now.toISOString().replace(/\D/g, '').slice(0, 14);
}

export function newTestSchemaName(now = new Date()): string {
  return `test_${timestamp(now)}_${randomBytes(4).toString('hex')}`;
}

export function isTestSchema(name: string): boolean {
  return TEST_SCHEMA.test(name);
}

function createdAt(name: string): Date | undefined {
  const digits = TEST_SCHEMA.exec(name)?.[1];
  if (!digits) return undefined;
  const iso = `${digits.slice(0, 4)}-${digits.slice(4, 6)}-${digits.slice(6, 8)}T${digits.slice(8, 10)}:${digits.slice(10, 12)}:${digits.slice(12, 14)}Z`;
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? undefined : date;
}

/** Schemas left behind by crashed runs: valid test names created more than 24 hours ago. */
export function staleTestSchemas(names: string[], now = new Date()): string[] {
  return names.filter((name) => {
    const created = createdAt(name);
    return created !== undefined && now.getTime() - created.getTime() > STALE_AFTER_MS;
  });
}
