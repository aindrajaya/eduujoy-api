import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { Client } from 'pg';
import { createDatabase } from '../database';
import { describeError } from '../redact';
import { countsByTopic, retireSeedItems } from '../seed/retire-seed';
import { parseSeed, readSeedFiles } from '../seed/seed-data';
import { loadDirectDatabaseUrl } from './env';
import { guardConnection } from './guard';

// Usage: pnpm db:seed:retire [--dir seed] [--apply] [--prod]
// Removes diagnostic items of seed topics whose seed_key is no longer in the seed files (lead gate,
// 2 Nov 2026). A dry run unless --apply. Nothing is deleted if any candidate is referenced: answered,
// or held in another table's jsonb or arrays (session state, replays). Run it after db:seed.

/** Seed keys a review marked as having a wrong answer key (seed/_review/verdicts.json, when present). */
function wrongKeyItems(dir: string): Set<string> {
  const file = join(dir, '_review', 'verdicts.json');
  if (!existsSync(file)) return new Set();
  const verdicts = JSON.parse(readFileSync(file, 'utf8')) as Record<string, { verdict?: { keyCorrect?: boolean } }>;
  return new Set(Object.entries(verdicts).filter(([, v]) => v.verdict?.keyCorrect === false).map(([key]) => key.replace('--', ':')));
}

async function main(): Promise<void> {
  const { values } = parseArgs({
    options: { dir: { type: 'string', default: 'seed' }, apply: { type: 'boolean', default: false }, prod: { type: 'boolean', default: false }, check: { type: 'boolean', default: false } },
  });
  const dir = resolve(values.dir);
  const data = parseSeed(readSeedFiles(dir));
  const seedKeys = data.items.map((item) => item.seedKey);
  if (values.check) {
    process.stdout.write(`db:seed:retire: ok (${seedKeys.length} items in the files)\n`);
    return;
  }

  const client = guardConnection(new Client({ connectionString: loadDirectDatabaseUrl() }), 'db:seed:retire');
  await client.connect();
  try {
    const result = await retireSeedItems(createDatabase(client), seedKeys, { apply: values.apply });
    const wrong = wrongKeyItems(dir);
    process.stdout.write(`${values.apply ? 'APPLY' : 'DRY RUN'}: ${result.candidates.length} seed item(s) are no longer in ${values.dir}/\n`);
    for (const [topic, n] of Object.entries(countsByTopic(result.candidates))) process.stdout.write(`  ${topic}: ${n}\n`);
    for (const c of result.candidates) {
      const refs = [c.answers > 0 ? `${c.answers} answer(s)` : '', ...Object.entries(c.heldBy).map(([where, n]) => `${n} in ${where}`)].filter(Boolean);
      process.stdout.write(`  - ${c.seedKey}${wrong.has(c.seedKey) ? '  [wrong key]' : ''}${refs.length ? `  REFERENCED: ${refs.join(', ')}` : ''}\n`);
    }
    const lines: Record<typeof result.outcome, string> = {
      nothing_to_do: 'Nothing to remove.',
      dry_run: `Would delete ${result.candidates.length}. Re-run with --apply to delete them.`,
      deleted: `Deleted ${result.deleted}.`,
      refused_referenced: `Refused: ${result.referenced.length} candidate(s) are referenced, so nothing was deleted.`,
      rolled_back_fk: 'Rolled back: a foreign key blocked the delete (an answer appeared), so nothing was deleted.',
    };
    process.stdout.write(`${lines[result.outcome]}\n`);
    if (result.outcome === 'refused_referenced' || result.outcome === 'rolled_back_fk') process.exitCode = 1;
  } finally {
    await client.end();
  }
}

main().catch((error: unknown) => {
  process.stderr.write(`db:seed:retire failed: ${describeError(error)}\n`);
  process.exitCode = 1;
});
