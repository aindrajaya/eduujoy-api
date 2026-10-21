import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseEnv } from 'node:util';

export interface DatabaseEnv {
  test: string | undefined;
  app: string | undefined;
  direct: string | undefined;
}

const KEYS = ['DATABASE_URL_TEST', 'DATABASE_URL', 'DATABASE_URL_DIRECT'] as const;

/** Reads only the database URLs: from the process env (CI), else from a local `.env`. */
export function readDatabaseEnv(): DatabaseEnv {
  const file = join(__dirname, '..', '..', '.env');
  const local = existsSync(file) ? parseEnv(readFileSync(file, 'utf8')) : {};
  const [test, app, direct] = KEYS.map((key) => process.env[key] ?? local[key]);
  return { test, app, direct };
}
