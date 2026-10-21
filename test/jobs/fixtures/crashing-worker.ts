// Child process for jobs.int-spec.ts: claims one `kill-test` job, reports progress, then hangs until
// the parent kills it with SIGKILL. Reads DATABASE_URL and EDUUJOY_TEST_SCHEMA from its env.
import { Logger } from '@nestjs/common';
import { Client } from 'pg';
import { createDatabase } from '../../../src/shared/db/database';
import { JobExecutor } from '../../../src/shared/jobs/job-executor';
import { JobSignals } from '../../../src/shared/jobs/job-queue';
import { JobRepository } from '../../../src/shared/jobs/job.repository';

Logger.overrideLogger(false);

async function main(): Promise<void> {
  const schema = process.env['EDUUJOY_TEST_SCHEMA'] ?? '';
  const client = new Client({ connectionString: process.env['DATABASE_URL'], options: `-c search_path="${schema}",public` });
  await client.connect();
  const repo = new JobRepository(createDatabase(client));
  const executor = new JobExecutor(repo, new JobSignals(), { problemBaseUrl: 'http://localhost:3000' });
  executor.register({
    type: process.env['KILL_TEST_TYPE'] ?? 'kill-test',
    concurrency: 1,
    timeoutMs: 60_000,
    parse: (p) => p,
    run: async (_p, ctx) => {
      await ctx.progress('analyse', 1, 3, 'Halfway, then the process dies');
      process.stdout.write(`RUNNING ${ctx.jobId}\n`);
      return new Promise(() => undefined);
    },
  });
  await executor.start();
}

void main();
