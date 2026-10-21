import {
  assertSafeTestDatabase,
  isTestSchema,
  newTestSchemaName,
  staleTestSchemas,
  UnsafeTestDatabaseError,
} from './test-database';

const TEST = 'postgresql://u:p@ep-test-1.ap-southeast-1.aws.neon.tech/neondb?sslmode=require';
const DEV = 'postgresql://u:p@ep-dev-2.ap-southeast-1.aws.neon.tech/neondb?sslmode=require';
const DEV_POOLED = 'postgresql://u:p@ep-dev-2-pooler.ap-southeast-1.aws.neon.tech/neondb?sslmode=require';

describe('assertSafeTestDatabase', () => {
  it('accepts a direct test URL on a different host', () => {
    expect(() => {
      assertSafeTestDatabase(TEST, [DEV, DEV_POOLED]);
    }).not.toThrow();
  });

  it('accepts when the app URLs are not configured (CI)', () => {
    expect(() => {
      assertSafeTestDatabase(TEST, [undefined, undefined]);
    }).not.toThrow();
  });

  it('refuses when the test URL is missing', () => {
    expect(() => {
      assertSafeTestDatabase(undefined, [DEV]);
    }).toThrow(UnsafeTestDatabaseError);
  });

  it('refuses the same string as an app URL', () => {
    expect(() => {
      assertSafeTestDatabase(DEV, [DEV, DEV_POOLED]);
    }).toThrow(UnsafeTestDatabaseError);
  });

  it('refuses the same host and database even with different parameters or credentials', () => {
    const disguised = 'postgres://other:pw@ep-dev-2.ap-southeast-1.aws.neon.tech/neondb?application_name=x';

    expect(() => {
      assertSafeTestDatabase(disguised, [DEV]);
    }).toThrow(UnsafeTestDatabaseError);
  });

  it('treats the pooled and direct hosts of one endpoint as the same database', () => {
    const directOfPooled = 'postgresql://u:p@ep-dev-2.ap-southeast-1.aws.neon.tech/neondb';

    expect(() => {
      assertSafeTestDatabase(directOfPooled, [DEV_POOLED]);
    }).toThrow(UnsafeTestDatabaseError);
  });

  it('refuses a pooled test URL, because search_path does not survive transaction pooling', () => {
    const pooledTest = 'postgresql://u:p@ep-test-1-pooler.ap-southeast-1.aws.neon.tech/neondb';

    expect(() => {
      assertSafeTestDatabase(pooledTest, [DEV]);
    }).toThrow(/pooled/);
  });

  it('never includes credentials in the error message', () => {
    let message = '';
    try {
      assertSafeTestDatabase(DEV, [DEV]);
    } catch (error) {
      message = (error as Error).message;
    }

    expect(message).toContain('DATABASE_URL_TEST');
    expect(message).not.toContain('u:p@');
    expect(message).not.toContain('ep-dev-2');
  });
});

describe('test schema names', () => {
  const now = new Date('2026-10-21T10:00:00Z');

  it('creates a timestamped, random name that the guard accepts', () => {
    const name = newTestSchemaName(now);

    expect(name).toMatch(/^test_20261021100000_[0-9a-f]{8}$/);
    expect(isTestSchema(name)).toBe(true);
  });

  it.each(['public', 'test', 'test_', 'testing_1', 'test_2026_x', 'test_20261021100000_ABCDEF12', 'test_20261021100000_abcdef12; drop'])(
    'rejects %j as a test schema',
    (name) => {
      expect(isTestSchema(name)).toBe(false);
    },
  );

  it('selects only test schemas older than 24 hours', () => {
    const names = [
      'public',
      'test_20261020095959_aaaaaaaa',
      'test_20261020100001_bbbbbbbb',
      'test_20261021095000_cccccccc',
      'test_legacy',
    ];

    expect(staleTestSchemas(names, now)).toEqual(['test_20261020095959_aaaaaaaa']);
  });
});
