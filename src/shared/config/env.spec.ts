import { EnvValidationError, parseEnv } from './env';

const valid = {
  NODE_ENV: 'production',
  PORT: '8000',
  APP_ORIGIN: 'https://eduujoy.aindrajaya.my.id,https://staging.eduujoy.aindrajaya.my.id',
  API_PUBLIC_URL: 'https://api.eduujoy.aindrajaya.my.id',
  DATABASE_URL: 'postgresql://app:pw@ep-x-pooler.eu-central-1.aws.neon.tech/neondb?sslmode=require',
  JWT_ACCESS_SECRET: 'j'.repeat(64),
  REFRESH_TOKEN_PEPPER: 'p'.repeat(64),
  GOOGLE_OAUTH_CLIENT_ID: 'client.apps.googleusercontent.com',
  GOOGLE_OAUTH_CLIENT_SECRET: 'google-secret',
  GOOGLE_OAUTH_REDIRECT_URI: 'https://api.eduujoy.aindrajaya.my.id/v1/auth/google/callback',
  ANTHROPIC_API_KEY: 'sk-ant-test',
  GEMINI_API_KEY: 'gemini-test',
  AI_DAILY_BUDGET_USD: '5',
  AI_DAILY_PAID_BUDGET_USD: '5',
  LEMONSQUEEZY_API_KEY: 'ls-api-key',
  LEMONSQUEEZY_STORE_ID: '123456',
  LEMONSQUEEZY_WEBHOOK_SECRET: 'w'.repeat(40),
  LEMONSQUEEZY_VARIANT_SUBSCRIPTION: '1111111',
  LEMONSQUEEZY_VARIANT_CREDIT_PACK: '2222222',
  LEMONSQUEEZY_MODE: 'live',
  YOUTUBE_API_KEY: 'unit-youtube-key',
  OPENALEX_API_KEY: 'unit-openalex-key',
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

  it('keeps path building off unless PATH_BUILDING_ENABLED is exactly "true" (user, 3 Nov 2026)', () => {
    expect(parseEnv(valid).PATH_BUILDING_ENABLED).toBe(false);
    expect(parseEnv({ ...valid, PATH_BUILDING_ENABLED: 'false' }).PATH_BUILDING_ENABLED).toBe(false);
    expect(parseEnv({ ...valid, PATH_BUILDING_ENABLED: 'true' }).PATH_BUILDING_ENABLED).toBe(true);
    for (const typo of ['1', 'yes', 'TRUE', '']) expect(() => parseEnv({ ...valid, PATH_BUILDING_ENABLED: typo })).toThrow(EnvValidationError);
  });

  it('applies defaults for PORT and NODE_ENV', () => {
    const env = parseEnv({ ...valid, NODE_ENV: undefined, PORT: undefined });

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
      expect((error as EnvValidationError).keys).toEqual([
        'AI_DAILY_BUDGET_USD',
        'AI_DAILY_PAID_BUDGET_USD',
        'ANTHROPIC_API_KEY',
        'API_PUBLIC_URL',
        'APP_ORIGIN',
        'DATABASE_URL',
        'GEMINI_API_KEY',
        'GOOGLE_OAUTH_CLIENT_ID',
        'GOOGLE_OAUTH_CLIENT_SECRET',
        'GOOGLE_OAUTH_REDIRECT_URI',
        'JWT_ACCESS_SECRET',
        'LEMONSQUEEZY_API_KEY',
        'LEMONSQUEEZY_MODE',
        'LEMONSQUEEZY_STORE_ID',
        'LEMONSQUEEZY_VARIANT_CREDIT_PACK',
        'LEMONSQUEEZY_VARIANT_SUBSCRIPTION',
        'LEMONSQUEEZY_WEBHOOK_SECRET',
        'OPENALEX_API_KEY',
        'REFRESH_TOKEN_PEPPER',
        'YOUTUBE_API_KEY',
      ]);
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

  it('treats an empty APP_VERSION as unset and validates KOYEB_GIT_SHA as hex', () => {
    expect(parseEnv({ ...valid, APP_VERSION: '' }).APP_VERSION).toBeUndefined();
    expect(parseEnv({ ...valid, KOYEB_GIT_SHA: 'a261098c0ffee1234567890abcdef1234567890' }).KOYEB_GIT_SHA).toBe('a261098c0ffee1234567890abcdef1234567890');
    expect(parseEnv({ ...valid, KOYEB_GIT_SHA: '' }).KOYEB_GIT_SHA).toBeUndefined();
    expect(() => parseEnv({ ...valid, KOYEB_GIT_SHA: 'main; rm -rf' })).toThrow(EnvValidationError);
  });

  it('accepts a short APP_VERSION and rejects unsafe ones', () => {
    expect(parseEnv({ ...valid, APP_VERSION: '1.2.3+abc123' }).APP_VERSION).toBe('1.2.3+abc123');
    expect(() => parseEnv({ ...valid, APP_VERSION: 'v1 <script>' })).toThrow(EnvValidationError);
  });

  it('requires a postgres DATABASE_URL and defaults DATABASE_SCHEMA to public', () => {
    expect(parseEnv(valid).DATABASE_SCHEMA).toBe('public');
    expect(() => parseEnv({ ...valid, DATABASE_URL: 'mysql://x@h/db' })).toThrow(EnvValidationError);
  });

  it('refuses the prod database outside production (lead gate, 23 Oct 2026)', () => {
    const prod = 'postgresql://app:pw@ep-raspy-recipe-bamuza67-pooler.c-8.eu-central-1.aws.neon.tech/neondb?sslmode=require';
    expect(parseEnv({ ...valid, DATABASE_URL: prod }).DATABASE_URL).toBe(prod);
    for (const NODE_ENV of ['development', 'test']) {
      expect(() => parseEnv({ ...valid, NODE_ENV, APP_ORIGIN: 'http://localhost:5173', API_PUBLIC_URL: 'http://localhost:3000', DATABASE_URL: prod })).toThrow(
        /DATABASE_URL: is the prod database; only NODE_ENV=production may use it/,
      );
    }
    const dev = { ...valid, NODE_ENV: 'development', APP_ORIGIN: 'http://localhost:5173', API_PUBLIC_URL: 'http://localhost:3000' };
    expect(parseEnv({ ...dev, DATABASE_URL: 'postgresql://app:pw@ep-cold-dew-ba8tyrlc-pooler.c-8.eu-central-1.aws.neon.tech/neondb' }).NODE_ENV).toBe('development');
    expect(() => parseEnv({ ...dev, PROD_DATABASE_ENDPOINTS: 'ep-cold-dew-ba8tyrlc', DATABASE_URL: 'postgresql://app:pw@ep-cold-dew-ba8tyrlc.c-8.eu-central-1.aws.neon.tech/neondb' })).toThrow(
      EnvValidationError,
    );
  });

  it('accepts only safe identifiers for DATABASE_SCHEMA', () => {
    expect(parseEnv({ ...valid, DATABASE_SCHEMA: 'test_20261021100000_ab12cd34' }).DATABASE_SCHEMA).toBe(
      'test_20261021100000_ab12cd34',
    );
    expect(() => parseEnv({ ...valid, DATABASE_SCHEMA: 'x"; drop schema public; --' })).toThrow(EnvValidationError);
  });

  it('rejects short secrets without echoing them', () => {
    let message = '';
    try {
      parseEnv({ ...valid, JWT_ACCESS_SECRET: 'tooshort-secret-value' });
    } catch (error) {
      message = (error as Error).message;
    }

    expect(message).toContain('JWT_ACCESS_SECRET: must be at least 32 characters');
    expect(message).not.toContain('tooshort-secret-value');
  });

  it('requires an explicit LEMONSQUEEZY_MODE, numeric ids and two different variants', () => {
    expect(parseEnv(valid).LEMONSQUEEZY_MODE).toBe('live');
    expect(() => parseEnv({ ...valid, LEMONSQUEEZY_MODE: undefined })).toThrow(EnvValidationError);
    expect(() => parseEnv({ ...valid, LEMONSQUEEZY_MODE: 'sandbox' })).toThrow(EnvValidationError);
    expect(() => parseEnv({ ...valid, LEMONSQUEEZY_STORE_ID: 'store-1' })).toThrow(EnvValidationError);
    expect(() => parseEnv({ ...valid, NODE_ENV: 'development', LEMONSQUEEZY_VARIANT_CREDIT_PACK: '1111111' })).toThrow(EnvValidationError);
  });

  it('rejects a short webhook secret without echoing it', () => {
    let message = '';
    try {
      parseEnv({ ...valid, LEMONSQUEEZY_WEBHOOK_SECRET: 'shortsecret' });
    } catch (error) {
      message = (error as Error).message;
    }

    expect(message).toContain('LEMONSQUEEZY_WEBHOOK_SECRET');
    expect(message).not.toContain('shortsecret');
  });

  it('requires a positive AI_DAILY_BUDGET_USD of at most 1000 and parses it as a number', () => {
    expect(parseEnv({ ...valid, AI_DAILY_BUDGET_USD: '7.5' }).AI_DAILY_BUDGET_USD).toBe(7.5);
    for (const bad of ['0', '-1', 'abc', '5000']) {
      expect(() => parseEnv({ ...valid, AI_DAILY_BUDGET_USD: bad })).toThrow(EnvValidationError);
    }
  });

  it('defaults the per-learner discovery caps to 1 (free) and 5 (paid), and accepts overrides', () => {
    expect(parseEnv(valid)).toMatchObject({ DISCOVERY_DAILY_PER_LEARNER_FREE: 1, DISCOVERY_DAILY_PER_LEARNER_PAID: 5 });
    expect(parseEnv({ ...valid, DISCOVERY_DAILY_PER_LEARNER_FREE: '2' }).DISCOVERY_DAILY_PER_LEARNER_FREE).toBe(2);
    expect(() => parseEnv({ ...valid, DISCOVERY_DAILY_PER_LEARNER_PAID: '-1' })).toThrow(EnvValidationError);
  });
});

