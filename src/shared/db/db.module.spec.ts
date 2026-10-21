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
    DATABASE_SCHEMA: 'public',
    ...overrides,
  });
}

describe('poolConfig', () => {
  it('keeps the pool small and sends no startup options for public', () => {
    const options = poolConfig(config({}));

    expect(options).toMatchObject({ connectionString: 'postgresql://u:p@h/db', max: 5 });
    expect(options).not.toHaveProperty('options');
  });

  it('pins search_path to the test schema with public kept for pgvector', () => {
    expect(poolConfig(config({ DATABASE_SCHEMA: 'test_20261021100000_ab12cd34' }))).toMatchObject({
      options: '-c search_path="test_20261021100000_ab12cd34",public',
    });
  });
});
