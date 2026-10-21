import { resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { sql } from 'drizzle-orm';
import { Client } from 'pg';
import { createDatabase } from '../database';
import { describeError } from '../redact';
import { topics } from '../schema';
import { loadSeed } from '../seed/load-seed';
import { parseSeed, readSeedFiles } from '../seed/seed-data';
import { loadDirectDatabaseUrl } from './env';

// Usage: pnpm db:seed [--dir seed] [--expect-topics 150]
async function main(): Promise<void> {
  const { values } = parseArgs({
    options: { dir: { type: 'string', default: 'seed' }, 'expect-topics': { type: 'string' }, check: { type: 'boolean', default: false } },
  });
  const dir = resolve(values.dir);
  const data = parseSeed(readSeedFiles(dir));
  // `--check` validates the seed and proves the script loads under its runner, without connecting.
  if (values.check) {
    process.stdout.write(`db:seed: ok (${data.topics.length} topics)\n`);
    return;
  }

  const client = new Client({ connectionString: loadDirectDatabaseUrl() });
  await client.connect();
  try {
    const db = createDatabase(client);
    const result = await loadSeed(db, data);
    const [count] = await db.select({ n: sql<number>`count(*)::int` }).from(topics);
    const total = count?.n ?? 0;
    process.stdout.write(
      `Seeded from ${values.dir}: ${result.topics} topics, ${result.prerequisites} prerequisite edges, ` +
        `${result.items} diagnostic items. Topics in database: ${total}\n`,
    );

    const expected = values['expect-topics'];
    if (expected !== undefined && total !== Number(expected)) {
      throw new Error(`Expected ${expected} topics in the database, found ${total}`);
    }
  } finally {
    await client.end();
  }
}

main().catch((error: unknown) => {
  process.stderr.write(`db:seed failed: ${describeError(error)}\n`);
  process.exitCode = 1;
});
