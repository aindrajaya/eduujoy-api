import { resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { parseSeed, readSeedFiles } from '../../src/shared/db/seed/seed-data';
import { runApply } from './apply';
import { runItems } from './items';
import { runRefine } from './refine';
import { runReview } from './review';
import { runTaxonomy } from './taxonomy';
import { SEED_DIR, totalSpentUsd } from './ledger';
import { SPEND_CAP_USD, usd } from './pricing';

// Credit-sprint seed tool (PRD-API §11). Run through the package scripts, which load ANTHROPIC_API_KEY
// with node --env-file; this tool never reads or prints env files or keys.
//
//   pnpm seed:taxonomy [--dry-run] [--sample N] [--go]
//   pnpm seed:items [--dry-run] [--sample N] [--go]     (--sample N: N topics, all five stages)
//   pnpm seed:items-review [--dry-run] [--sample N] [--min-margin F] [--go]   (flagged items only; --sample N: top N)
//   pnpm seed:items-apply [--dry-run]   (free: applies review verdicts to seed/items, parser-checked)
//   pnpm seed:topics-refine [--dry-run] [--sample N] [--min-cosine F | --topics a,b,c] [--go]   (near-neighbour topics: description and aliases)
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
      'min-margin': { type: 'string', default: '0' },
      // Geometry vs trigonometry, the pair behind the held-out failure (22 Oct 2026).
      'min-cosine': { type: 'string', default: '0.789' },
      topics: { type: 'string' },
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
    case 'items-review': {
      const sample = values.sample === undefined ? undefined : positiveInt(values.sample, '--sample');
      const minMargin = Number(values['min-margin']);
      if (!(minMargin >= 0 && minMargin < 1)) throw new Error('--min-margin must be a fraction from 0 to under 1');
      await runReview({ dryRun: values['dry-run'], go: values.go, sample, minMargin });
      return;
    }
    case 'items-apply': {
      runApply({ dryRun: values['dry-run'] });
      return;
    }
    case 'topics-refine': {
      const sample = values.sample === undefined ? undefined : positiveInt(values.sample, '--sample');
      const minCosine = Number(values['min-cosine']);
      if (!(minCosine > 0 && minCosine < 1)) throw new Error('--min-cosine must be a fraction between 0 and 1');
      const topics = values.topics?.split(',').map((s) => s.trim()).filter(Boolean);
      await runRefine({ dryRun: values['dry-run'], go: values.go, sample, minCosine, topics });
      return;
    }
    case 'validate': {
      validate(values.dir ? resolve(values.dir) : SEED_DIR, values['expect-topics']);
      return;
    }
    default:
      throw new Error(`Unknown command "${command ?? ''}". Commands: taxonomy, items, items-review, items-apply, topics-refine, validate`);
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
