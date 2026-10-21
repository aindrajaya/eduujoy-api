import { EnvValidationError, parseEnv } from './env';

const valid = {
  NODE_ENV: 'production',
  PORT: '8000',
  APP_ORIGIN: 'https://eduujoy.aindrajaya.my.id,https://staging.eduujoy.aindrajaya.my.id',
  API_PUBLIC_URL: 'https://api.eduujoy.aindrajaya.my.id',
  DATABASE_URL: 'postgresql://app:pw@ep-x-pooler.eu-central-1.aws.neon.tech/neondb?sslmode=require',
};

describe('parseEnv', () => {
  it('parses a complete production env', () => {
    const env = parseEnv(valid);

    expect(env.NODE_ENV).toBe('production');
    expect(env.PORT).toBe(8000);
    expect(env.APP_ORIGIN).toEqual([
      'https://eduujoy.aindrajaya.my.id',
      'https://staging.eduujoy.aindrajaya.my.id',
    ]);
    expect(env.API_PUBLIC_URL).toBe('https://api.eduujoy.aindrajaya.my.id');
    expect(env.LOG_LEVEL).toBe('info');
  });

  it('applies defaults for PORT and NODE_ENV', () => {
    const env = parseEnv({
      APP_ORIGIN: valid.APP_ORIGIN,
      API_PUBLIC_URL: valid.API_PUBLIC_URL,
      DATABASE_URL: valid.DATABASE_URL,
    });

    expect(env.PORT).toBe(3000);
    expect(env.NODE_ENV).toBe('development');
  });

  it('trims origins, drops empty entries and strips trailing slashes', () => {
    const env = parseEnv({ ...valid, NODE_ENV: 'development', APP_ORIGIN: ' http://localhost:5173/ , ,https://a.example ' });

    expect(env.APP_ORIGIN).toEqual(['http://localhost:5173', 'https://a.example']);
  });

  it('rejects an origin with a path', () => {
    expect(() => parseEnv({ ...valid, APP_ORIGIN: 'https://a.example/app' })).toThrow(EnvValidationError);
  });

  it('refuses to start when required keys are missing and names them', () => {
    expect.assertions(3);
    try {
      parseEnv({});
    } catch (error) {
      expect(error).toBeInstanceOf(EnvValidationError);
      expect((error as EnvValidationError).keys).toEqual(['API_PUBLIC_URL', 'APP_ORIGIN', 'DATABASE_URL']);
      expect((error as Error).message).toContain('APP_ORIGIN');
    }
  });

  it('never echoes the rejected value in the error message', () => {
    const secretLooking = 'not-a-url-but-maybe-a-secret-1234567890';

    let message = '';
    try {
      parseEnv({ ...valid, API_PUBLIC_URL: secretLooking });
    } catch (error) {
      message = (error as Error).message;
    }

    expect(message).toContain('API_PUBLIC_URL');
    expect(message).not.toContain(secretLooking);
  });

  it('rejects a non-numeric or out-of-range PORT', () => {
    expect(() => parseEnv({ ...valid, PORT: 'abc' })).toThrow(EnvValidationError);
    expect(() => parseEnv({ ...valid, PORT: '70000' })).toThrow(EnvValidationError);
  });

  it('requires https origins in production', () => {
    expect(() => parseEnv({ ...valid, APP_ORIGIN: 'http://eduujoy.aindrajaya.my.id' })).toThrow(
      EnvValidationError,
    );
    expect(() =>
      parseEnv({ ...valid, NODE_ENV: 'development', APP_ORIGIN: 'http://localhost:5173' }),
    ).not.toThrow();
  });

  it('accepts a short APP_VERSION and rejects unsafe ones', () => {
    expect(parseEnv({ ...valid, APP_VERSION: '1.2.3+abc123' }).APP_VERSION).toBe('1.2.3+abc123');
    expect(() => parseEnv({ ...valid, APP_VERSION: 'v1 <script>' })).toThrow(EnvValidationError);
  });

  it('requires a postgres DATABASE_URL and defaults DATABASE_SCHEMA to public', () => {
    expect(parseEnv(valid).DATABASE_SCHEMA).toBe('public');
    expect(() => parseEnv({ ...valid, DATABASE_URL: 'mysql://x@h/db' })).toThrow(EnvValidationError);
  });

  it('accepts only safe identifiers for DATABASE_SCHEMA', () => {
    expect(parseEnv({ ...valid, DATABASE_SCHEMA: 'test_20261021100000_ab12cd34' }).DATABASE_SCHEMA).toBe(
      'test_20261021100000_ab12cd34',
    );
    expect(() => parseEnv({ ...valid, DATABASE_SCHEMA: 'x"; drop schema public; --' })).toThrow(EnvValidationError);
  });
});
