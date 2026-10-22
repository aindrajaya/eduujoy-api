import { Client } from 'pg';
import { runMigrations } from '../migrate';
import { describeError } from '../redact';
import { loadDirectDatabaseUrl } from './env';
import { guardConnection } from './guard';

async function main(): Promise<void> {
  // `--check` proves the script loads under its runner (test/cli/cli-boot.int-spec.ts) without connecting.
  if (process.argv.includes('--check')) {
    process.stdout.write('db:migrate: ok\n');
    return;
  }
  // One session (advisory lock, transactions): a dropped connection fails the run cleanly; re-run it.
  const client = guardConnection(new Client({ connectionString: loadDirectDatabaseUrl() }), 'db:migrate');
  await client.connect();
  try {
    const applied = await runMigrations(client);
    process.stdout.write(
      applied.length === 0 ? 'Migrations: up to date\n' : `Migrations applied: ${applied.join(', ')}\n`,
    );
  } finally {
    await client.end();
  }
}

main().catch((error: unknown) => {
  process.stderr.write(`db:migrate failed: ${describeError(error)}\n`);
  process.exitCode = 1;
});
