import { AppConfig } from '../config';
import { type Env } from '../config/env';
import { poolConfig } from './db.module';

function config(overrides: Partial<Env>): AppConfig {
  return new AppConfig({
    NODE_ENV: 'test',
    PORT: 3000,
    LOG_LEVEL: 'silent',
    APP_ORIGIN: ['http://localhost:5173'],
    API_PUBLIC_URL: 'http://localhost:3000',
    DATABASE_URL: 'postgresql://u:p@h/db',
    PATH_RESOURCE_LANGUAGE: 'en',
    PATH_BUILDING_ENABLED: false,
    DATABASE_SCHEMA: 'public',
    JWT_ACCESS_SECRET: 'j'.repeat(64),
    REFRESH_TOKEN_PEPPER: 'p'.repeat(64),
    GOOGLE_OAUTH_CLIENT_ID: 'id',
    GOOGLE_OAUTH_CLIENT_SECRET: 'secret',
    GOOGLE_OAUTH_REDIRECT_URI: 'http://localhost:3000/v1/auth/google/callback',
    ANTHROPIC_API_KEY: 'a',
    GEMINI_API_KEY: 'g',
    AI_DAILY_BUDGET_USD: 5,
    AI_DAILY_PAID_BUDGET_USD: 20,
    DISCOVERY_DAILY_PER_LEARNER_FREE: 1,
    DISCOVERY_DAILY_PER_LEARNER_PAID: 5,
    LEMONSQUEEZY_API_KEY: 'ls',
    LEMONSQUEEZY_STORE_ID: '1',
    LEMONSQUEEZY_WEBHOOK_SECRET: 'w'.repeat(40),
    LEMONSQUEEZY_VARIANT_SUBSCRIPTION: '2',
    LEMONSQUEEZY_VARIANT_CREDIT_PACK: '3',
    LEMONSQUEEZY_MODE: 'test',
    YOUTUBE_API_KEY: 'test-youtube-key',
    OPENALEX_API_KEY: 'test-openalex-key',
    ...overrides,
  });
}

describe('poolConfig', () => {
  it('keeps the pool small and sends no startup options for public', () => {
    const options = poolConfig(config({}));

    expect(options).toMatchObject({ connectionString: 'postgresql://u:p@h/db', max: 5 });
    expect(options).not.toHaveProperty('options');
  });

  it('keeps idle clients short-lived, uses TCP keep-alive and bounds connects (Neon resets)', () => {
    expect(poolConfig(config({}))).toMatchObject({
      idleTimeoutMillis: 10_000,
      connectionTimeoutMillis: 5_000,
      keepAlive: true,
      keepAliveInitialDelayMillis: 10_000,
    });
  });

  it('pins search_path to the test schema with public kept for pgvector', () => {
    expect(poolConfig(config({ DATABASE_SCHEMA: 'test_20261021100000_ab12cd34' }))).toMatchObject({
      options: '-c search_path="test_20261021100000_ab12cd34",public',
    });
  });
});
