import { existsSync } from 'node:fs';
import { z } from 'zod';

const directUrl = z
  .string({ error: 'DATABASE_URL_DIRECT is missing' })
  .regex(/^postgres(ql)?:\/\//, { error: 'DATABASE_URL_DIRECT must be a postgres:// URL' })
  .refine((url) => !url.includes('-pooler'), {
    error: 'DATABASE_URL_DIRECT must be the direct (non-pooled) Neon connection',
  });

/** CLI scripts run outside Nest; they read `.env` for local use and validate only what they need. */
export function loadDirectDatabaseUrl(): string {
  if (existsSync('.env')) process.loadEnvFile('.env');
  const result = directUrl.safeParse(process.env['DATABASE_URL_DIRECT']);
  if (!result.success) throw new Error(result.error.issues.map((issue) => issue.message).join('; '));
  return result.data;
}
