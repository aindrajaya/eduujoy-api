import { Client } from 'pg';
import { describeError } from '../../src/shared/db/redact';
import { readDatabaseEnv } from './database-env';
import { sweepStaleTestSchemas } from './sweep';
import { assertSafeTestDatabase } from './test-database';

// pnpm db:test:cleanup — also runs daily in CI (.github/workflows/test-db-cleanup.yml).
async function main(): Promise<void> {
  const env = readDatabaseEnv();
  assertSafeTestDatabase(env.test, [env.app, env.direct]);
  const client = new Client({ connectionString: env.test });
  await client.connect();
  try {
    const dropped = await sweepStaleTestSchemas(client);
    process.stdout.write(`Dropped ${dropped.length} stale test schema(s)${dropped.length ? `: ${dropped.join(', ')}` : ''}\n`);
  } finally {
    await client.end();
  }
}

main().catch((error: unknown) => {
  process.stderr.write(`db:test:cleanup failed: ${describeError(error)}\n`);
  process.exitCode = 1;
});
