import { parseArgs } from 'node:util';
import { runConceptMaps, validateConceptMaps } from './concept-maps';
import { totalSpentUsd } from './ledger';
import { SPEND_CAP_USD, usd } from './pricing';

// Own entry point, not cli.ts: cli.ts loads every other seed command, and their PromptRegistry instances
// read every prompt file, including the eval ones. This one loads only the concept-map generator, so its
// reads stay on its allow-list (tools/seed/concept-maps.test.ts walks this file's imports).
//
//   pnpm seed:concept-maps --stage draft|review|assemble [--dry-run] [--sample N] [--go] [--expect-topics N]
//   pnpm seed:concept-maps-validate [--expect-topics N]

function positiveInt(value: string, flag: string): number {
  const n = Number(value);
  if (!Number.isInteger(n) || n < 1) throw new Error(`${flag} must be a positive integer`);
  return n;
}

async function main(): Promise<void> {
  const { positionals, values } = parseArgs({
    allowPositionals: true,
    options: {
      stage: { type: 'string' },
      'dry-run': { type: 'boolean', default: false },
      go: { type: 'boolean', default: false },
      sample: { type: 'string' },
      'expect-topics': { type: 'string' },
    },
  });
  const expectTopics = values['expect-topics'] === undefined ? undefined : positiveInt(values['expect-topics'], '--expect-topics');
  if (positionals[0] === 'validate') {
    validateConceptMaps(expectTopics);
    return;
  }
  process.stdout.write(`Spent so far: ${usd(totalSpentUsd())} of US$${SPEND_CAP_USD}\n`);
  const stage = values.stage;
  if (stage !== 'draft' && stage !== 'review' && stage !== 'assemble') throw new Error('--stage must be draft, review or assemble');
  const sample = values.sample === undefined ? undefined : positiveInt(values.sample, '--sample');
  await runConceptMaps({ stage, dryRun: values['dry-run'], go: values.go, sample, expectTopics });
}

main().catch((error: unknown) => {
  process.stderr.write(`seed failed: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
