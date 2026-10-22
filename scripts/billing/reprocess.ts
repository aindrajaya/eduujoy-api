import { Client } from 'pg';
import { ReprocessBillingEvent } from '../../src/modules/billing/application/reprocess-billing-event.usecase';
import { DrizzleBillingRepository } from '../../src/modules/billing/infrastructure/drizzle-billing.repository';
import { createDatabase } from '../../src/shared/db';
import { loadDirectDatabaseUrl } from '../../src/shared/db/cli/env';
import { describeError } from '../../src/shared/db/redact';
import { JobQueue, JobRepository, JobSignals } from '../../src/shared/jobs';

// Operator CLI: `pnpm billing:reprocess <eventId>` shows the event's state (dry run);
// `pnpm billing:reprocess <eventId> --yes` queues a fresh billing-event job for it. Only events never
// processed (processed_at null) are queued, and a repeat run cannot credit twice. The API's executor
// is push-driven, so the job runs on its next wake-up (any webhook or job) or its next restart.
// Prints the target database host first; never prints the event payload. Wired by hand (tsx emits no
// decorator metadata).

export function buildReprocess(client: Client): ReprocessBillingEvent {
  const db = createDatabase(client);
  return new ReprocessBillingEvent(new DrizzleBillingRepository(db), new JobQueue(new JobRepository(db), new JobSignals()));
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const check = args.includes('--check');
  const url = check ? 'postgresql://check@localhost/check' : loadDirectDatabaseUrl();
  const client = new Client({ connectionString: url });
  const reprocess = buildReprocess(client);
  if (check) {
    process.stdout.write(`billing:reprocess: ok (${reprocess.constructor.name})\n`);
    return;
  }
  const eventId = args.find((a) => !a.startsWith('--'));
  if (!eventId) throw new Error('Usage: pnpm billing:reprocess <eventId> [--yes]');
  const target = new URL(url);
  process.stdout.write(`Database: ${target.hostname}/${target.pathname.replace(/^\//, '')}\n`);
  await client.connect();
  try {
    const result = await reprocess.execute(eventId, { dryRun: !args.includes('--yes') });
    switch (result.outcome) {
      case 'not_found':
        process.stdout.write(`No billing event ${eventId}\n`);
        process.exitCode = 1;
        break;
      case 'already_processed':
        process.stdout.write(`${result.type} was already processed at ${result.processedAt.toISOString()}; nothing queued\n`);
        break;
      case 'would_queue':
        process.stdout.write(`${result.type} is unprocessed. Re-run with --yes to queue it.\n`);
        break;
      case 'queued':
        process.stdout.write(`Queued job ${result.jobId} for ${result.type}. It runs on the API's next wake-up or restart.\n`);
        break;
    }
  } finally {
    await client.end();
  }
}

main().catch((error: unknown) => {
  process.stderr.write(`billing:reprocess failed: ${describeError(error)}\n`);
  process.exitCode = 1;
});
