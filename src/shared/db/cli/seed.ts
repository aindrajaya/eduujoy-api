import { resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { Client } from 'pg';
import { createDatabase } from '../database';
import { describeError } from '../redact';
import { loadSeed } from '../seed/load-seed';
import { parseSeed, readSeedFiles } from '../seed/seed-data';
import { topicCounts } from '../seed/topic-counts';
import { loadDirectDatabaseUrl } from './env';
import { guardConnection } from './guard';

// Usage: pnpm db:seed [--dir seed] [--expect-topics 160]
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

  // One session (one transaction): a dropped connection fails the load cleanly; re-run it.
  const client = guardConnection(new Client({ connectionString: loadDirectDatabaseUrl() }), 'db:seed');
  await client.connect();
  try {
    const db = createDatabase(client);
    const result = await loadSeed(db, data);
    const counts = await topicCounts(db);
    process.stdout.write(
      `Seeded from ${values.dir}: ${result.topics} topics, ${result.prerequisites} prerequisite edges, ` +
        `${result.items} diagnostic items. Seed topics in database: ${counts.seed} (plus ${counts.other} learner or reviewer topics)\n`,
    );

    // Only seed topics are checked: learner-created topics are legitimate in prod (23 Oct 2026, the prod
    // seed found 161 with one learner topic and failed).
    const expected = values['expect-topics'];
    if (expected !== undefined && counts.seed !== Number(expected)) {
      throw new Error(`Expected ${expected} seed topics in the database, found ${counts.seed}`);
    }
  } finally {
    await client.end();
  }
}

main().catch((error: unknown) => {
  process.stderr.write(`db:seed failed: ${describeError(error)}\n`);
  process.exitCode = 1;
});
