import { resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { parseSeed, readSeedFiles } from '../../src/shared/db/seed/seed-data';
import { runItems } from './items';
import { runTaxonomy } from './taxonomy';
import { SEED_DIR, totalSpentUsd } from './ledger';
import { SPEND_CAP_USD, usd } from './pricing';

// Credit-sprint seed tool (PRD-API §11). Run through the package scripts, which load ANTHROPIC_API_KEY
// with node --env-file; this tool never reads or prints env files or keys.
//
//   pnpm seed:taxonomy [--dry-run] [--sample N] [--go]
//   pnpm seed:items [--dry-run] [--sample N] [--go]     (--sample N: N topics, all five stages)
//   pnpm seed:validate [--dir seed] [--expect-topics N]
//
// Paid runs need --go and print their estimate first; --dry-run never calls the API.

async function main(): Promise<void> {
  const { positionals, values } = parseArgs({
    allowPositionals: true,
    options: {
      'dry-run': { type: 'boolean', default: false },
      go: { type: 'boolean', default: false },
      sample: { type: 'string' },
      dir: { type: 'string' },
      'expect-topics': { type: 'string' },
    },
  });
  const command = positionals[0];
  process.stdout.write(`Spent so far: ${usd(totalSpentUsd())} of US$${SPEND_CAP_USD}\n`);

  switch (command) {
    case 'taxonomy': {
      const sample = values.sample === undefined ? undefined : positiveInt(values.sample, '--sample');
      await runTaxonomy({ dryRun: values['dry-run'], go: values.go, sample });
      return;
    }
    case 'items': {
      const sample = values.sample === undefined ? undefined : positiveInt(values.sample, '--sample');
      await runItems({ dryRun: values['dry-run'], go: values.go, sample });
      return;
    }
    case 'validate': {
      validate(values.dir ? resolve(values.dir) : SEED_DIR, values['expect-topics']);
      return;
    }
    default:
      throw new Error(`Unknown command "${command ?? ''}". Commands: taxonomy, items, validate`);
  }
}

/** Runs the db:seed parser without a database: same strict checks, nothing loaded. */
function validate(dir: string, expectTopics: string | undefined): void {
  const data = parseSeed(readSeedFiles(dir));
  const domains = ['software', 'stem', 'non_technical'].map((d) => `${d} ${data.topics.filter((t) => t.domain === d).length}`);
  const edges = data.topics.reduce((n, t) => n + t.prerequisites.length, 0);
  process.stdout.write(`Valid seed v1: ${data.topics.length} topics (${domains.join(', ')}), ${edges} prerequisite edges, ${data.items.length} items\n`);
  if (expectTopics !== undefined && data.topics.length !== positiveInt(expectTopics, '--expect-topics')) {
    throw new Error(`Expected ${expectTopics} topics, found ${data.topics.length}`);
  }
}

function positiveInt(value: string, flag: string): number {
  const n = Number(value);
  if (!Number.isInteger(n) || n < 1) throw new Error(`${flag} must be a positive integer`);
  return n;
}

main().catch((error: unknown) => {
  process.stderr.write(`seed failed: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
