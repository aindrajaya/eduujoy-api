import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  assertSchemaName,
  MigrationDriftError,
  planMigrations,
  readMigrations,
  retargetSql,
  splitStatements,
} from './migrations';

function migrationsDir(files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), 'mig-'));
  mkdirSync(join(dir, 'meta'));
  const entries = Object.keys(files).map((tag, idx) => ({ idx, version: '7', when: idx, tag, breakpoints: true }));
  writeFileSync(join(dir, 'meta', '_journal.json'), JSON.stringify({ version: '7', dialect: 'postgresql', entries }));
  for (const [tag, sql] of Object.entries(files)) writeFileSync(join(dir, `${tag}.sql`), sql);
  return dir;
}

describe('splitStatements', () => {
  it('splits on drizzle statement breakpoints and drops empty chunks', () => {
    expect(splitStatements('CREATE TABLE a();--> statement-breakpoint\nCREATE TABLE b();\n')).toEqual([
      'CREATE TABLE a();',
      'CREATE TABLE b();',
    ]);
  });
});

describe('retargetSql', () => {
  it('rewrites "public". qualifiers to the target schema', () => {
    const sql = 'CREATE TYPE "public"."plan" AS ENUM(\'free\'); ALTER TABLE "x" ADD FOREIGN KEY ("u") REFERENCES "public"."users"("id");';

    expect(retargetSql(sql, 'test_1')).toBe(
      'CREATE TYPE "test_1"."plan" AS ENUM(\'free\'); ALTER TABLE "x" ADD FOREIGN KEY ("u") REFERENCES "test_1"."users"("id");',
    );
  });

  it('leaves the unquoted extension schema alone so pgvector stays in public', () => {
    const sql = 'CREATE EXTENSION IF NOT EXISTS vector WITH SCHEMA public;';

    expect(retargetSql(sql, 'test_1')).toBe(sql);
  });

  it('is a no-op for the public schema', () => {
    expect(retargetSql('"public"."users"', 'public')).toBe('"public"."users"');
  });
});

describe('assertSchemaName', () => {
  it.each(['public', 'test_20261021_ab12'])('accepts %s', (name) => {
    expect(() => {
      assertSchemaName(name);
    }).not.toThrow();
  });

  it.each(['Public', 'drop table', 'a"b', '', 'x'.repeat(64)])('rejects %j', (name) => {
    expect(() => {
      assertSchemaName(name);
    }).toThrow(/schema name/);
  });
});

describe('readMigrations', () => {
  it('reads journal entries in order with statements and a content hash', () => {
    const dir = migrationsDir({ '0000_a': 'SELECT 1;', '0001_b': 'SELECT 2;--> statement-breakpoint\nSELECT 3;' });

    const migrations = readMigrations(dir);

    expect(migrations.map((m) => m.tag)).toEqual(['0000_a', '0001_b']);
    expect(migrations[1]?.statements).toEqual(['SELECT 2;', 'SELECT 3;']);
    expect(migrations[0]?.hash).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe('planMigrations', () => {
  const all = [
    { tag: '0000_a', hash: 'h0', statements: [] },
    { tag: '0001_b', hash: 'h1', statements: [] },
  ];

  it('returns every migration for an empty history', () => {
    expect(planMigrations(all, []).map((m) => m.tag)).toEqual(['0000_a', '0001_b']);
  });

  it('returns only migrations not yet applied', () => {
    expect(planMigrations(all, [{ tag: '0000_a', hash: 'h0' }]).map((m) => m.tag)).toEqual(['0001_b']);
  });

  it('refuses when an applied migration was edited afterwards', () => {
    expect(() => planMigrations(all, [{ tag: '0000_a', hash: 'changed' }])).toThrow(MigrationDriftError);
  });

  it('refuses when the database has a migration this build does not know', () => {
    expect(() => planMigrations(all, [{ tag: '0009_future', hash: 'x' }])).toThrow(MigrationDriftError);
  });
});
