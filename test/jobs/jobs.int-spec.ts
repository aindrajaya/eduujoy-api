import { type ChildProcess, spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { Logger } from '@nestjs/common';
import { type Client } from 'pg';
import { JobExecutor } from '../../src/shared/jobs/job-executor';
import { JobSignals } from '../../src/shared/jobs/job-queue';
import { JobRepository } from '../../src/shared/jobs/job.repository';
import { connectTestClient, testDb } from '../db/connect';

jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);

/** Starts the crashing worker and resolves with the job id once it reports the job is running. */
function startWorker(type: string): Promise<{ child: ChildProcess; jobId: string }> {
  const child = spawn(process.execPath, ['--import', 'tsx', join(__dirname, 'fixtures', 'crashing-worker.ts')], {
    env: { ...process.env, KILL_TEST_TYPE: type },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error('worker never reported RUNNING'));
    }, 20_000);
    let out = '';
    child.stdout.on('data', (chunk: Buffer) => {
      out += chunk.toString();
      const match = /RUNNING (\S+)/.exec(out);
      if (match?.[1]) {
        clearTimeout(timeout);
        resolve({ child, jobId: match[1] });
      }
    });
    child.on('exit', (code) => {
      clearTimeout(timeout);
      reject(new Error(`worker exited early with code ${String(code)}`));
    });
  });
}

describe('jobs: a killed process resumes its running job (PRD-API §13 A5 Verify)', () => {
  let client: Client;
  let repo: JobRepository;

  beforeAll(async () => {
    client = await connectTestClient();
    repo = new JobRepository(testDb(client));
  });

  afterAll(async () => {
    await client.end();
  });

  it('requeues a job left running by SIGKILL once its lock is stale and completes it on the next boot', async () => {
    const type = `kill-${randomUUID().slice(0, 8)}`;
    const { job } = await repo.enqueue({ type, idempotencyKey: randomUUID(), payload: { topic: 'react-hooks' }, maxAttempts: 3 });

    const { child, jobId } = await startWorker(type);
    expect(jobId).toBe(job.id);
    const exited = new Promise((resolve) => child.on('exit', resolve));
    child.kill('SIGKILL');
    await exited;

    // The process died mid-run: the row is stranded in `running`, with the first attempt counted.
    expect(await repo.findById(job.id)).toMatchObject({ status: 'running', attempts: 1, progress: { stage: 'analyse', done: 1 } });

    // A lock is only treated as abandoned once it is older than the longest handler timeout plus
    // staleGraceMs (overlapping deploys keep their jobs). Short values let the test see it go stale.
    const executor = new JobExecutor(repo, new JobSignals(), { problemBaseUrl: 'http://localhost:3000', staleGraceMs: 0 });
    executor.register({
      type,
      concurrency: 1,
      // Long enough for the database round trips of one run from a local machine to Frankfurt (500 ms
      // timed the second attempt out); the lock then goes stale after this plus staleGraceMs 0.
      timeoutMs: 5_000,
      parse: (p): { topic: string } => p as { topic: string },
      run: async (p, ctx) => {
        await ctx.progress('design', 3, 3);
        return { resultRef: `/v1/paths/for-${p.topic}` };
      },
    });
    await executor.start();
    const until = Date.now() + 20_000;
    while ((await repo.findById(job.id))?.status !== 'succeeded' && Date.now() < until) await new Promise((r) => setTimeout(r, 50));
    await executor.idle();
    await executor.stop();

    expect(await repo.findById(job.id)).toMatchObject({
      status: 'succeeded',
      attempts: 2,
      result: { resultRef: '/v1/paths/for-react-hooks' },
    });
    const events = await repo.eventsAfter(job.id);
    expect(events.map((e) => e.type)).toEqual(['progress', 'progress', 'completed']);
  }, 60_000);
});
