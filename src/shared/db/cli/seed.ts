import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { Client } from 'pg';
import { createDatabase, type Database } from '../database';
import { describeError } from '../redact';
import { loadSeed } from '../seed/load-seed';
import { SeedRetireRefusedError } from '../seed/retire-policy';
import { parseSeed, readSeedFiles } from '../seed/seed-data';
import { topicCounts } from '../seed/topic-counts';
import { loadDirectDatabaseUrl } from './env';
import { guardConnection } from './guard';

// Usage: pnpm db:seed [--dir seed] [--expect-topics 160] [--expect-retired N] [--dry-run] [--prod]
// --dry-run loads everything in one transaction and rolls it back: real counts, nothing written.
// Items that left the files are retired (inactive, never served to new sessions, rows kept): when any
// would retire, --expect-retired must name the exact count (the dry run prints it). A short --dir, or
// more than 1% (at most 200) of the active seed items, is refused with nothing written.
/** The resolved --dir, for the refusal message's [wrong key] marks. */
let seedDir = resolve('seed');

class DryRunRollback extends Error {
  override name = 'DryRunRollback';
}

async function main(): Promise<void> {
  const { values } = parseArgs({
    options: {
      dir: { type: 'string', default: 'seed' },
      'expect-topics': { type: 'string' },
      check: { type: 'boolean', default: false },
      'dry-run': { type: 'boolean', default: false },
      'expect-retired': { type: 'string' },
      // Read by the target guard (loadDirectDatabaseUrl); declared so the strict parser accepts it.
      prod: { type: 'boolean', default: false },
    },
  });
  const dir = resolve(values.dir);
  seedDir = dir;
  const data = parseSeed(readSeedFiles(dir));
  const expectRaw = values['expect-retired'];
  if (expectRaw !== undefined && !/^\d{1,6}$/.test(expectRaw)) throw new Error('--expect-retired must be a whole number');
  const expectRetired = expectRaw === undefined ? undefined : Number(expectRaw);
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
    const dryRun = values['dry-run'];
    const report = async (exec: Database): Promise<void> => {
      const result = await loadSeed(exec, data, expectRetired === undefined ? {} : { expectRetired });
      const counts = await topicCounts(exec);
      process.stdout.write(
        `${dryRun ? 'DRY RUN (rolled back): would seed' : 'Seeded'} from ${values.dir}: ${result.topics} topics, ${result.prerequisites} prerequisite edges, ` +
          `${result.items} diagnostic items. Seed topics in database: ${counts.seed} (plus ${counts.other} learner or reviewer topics)\n` +
          `${dryRun ? 'Would retire' : 'Retired'} ${result.retired.length} item(s) no longer in the files; ${result.restored} retired item(s) back in the files are active again.\n`,
      );
      printKeys(result.retired, wrongKeyItems(dir));
      // Only seed topics are checked: learner-created topics are legitimate in prod (23 Oct 2026, the prod
      // seed found 161 with one learner topic and failed).
      const expected = values['expect-topics'];
      if (expected !== undefined && counts.seed !== Number(expected)) {
        throw new Error(`Expected ${expected} seed topics in the database, found ${counts.seed}`);
      }
    };
    if (!dryRun) await report(db);
    else {
      // loadSeed's own transaction becomes a savepoint inside this one, which always rolls back.
      await db
        .transaction(async (tx) => {
          await report(tx);
          throw new DryRunRollback();
        })
        .catch((error: unknown) => {
          if (!(error instanceof DryRunRollback)) throw error;
        });
    }
  } finally {
    await client.end();
  }
}

/** Seed keys a review marked as having a wrong answer key (seed/_review/verdicts.json, when present). */
function wrongKeyItems(dir: string): Set<string> {
  const file = join(dir, '_review', 'verdicts.json');
  if (!existsSync(file)) return new Set();
  const verdicts = JSON.parse(readFileSync(file, 'utf8')) as Record<string, { verdict?: { keyCorrect?: boolean } }>;
  return new Set(Object.entries(verdicts).filter(([, v]) => v.verdict?.keyCorrect === false).map(([key]) => key.replace('--', ':')));
}

function printKeys(keys: string[], wrong: Set<string>): void {
  for (const key of keys) process.stdout.write(`  - ${key}${wrong.has(key) ? '  [wrong key]' : ''}\n`);
}

main().catch((error: unknown) => {
  if (error instanceof SeedRetireRefusedError) {
    process.stderr.write(`db:seed: ${error.message}\n`);
    printKeys(error.detail.keys.slice(0, 50), wrongKeyItems(seedDir));
    process.exitCode = 1;
    return;
  }
  process.stderr.write(`db:seed failed: ${describeError(error)}\n`);
  process.exitCode = 1;
});
