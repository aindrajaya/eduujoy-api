import { randomUUID } from 'node:crypto';
import { Logger } from '@nestjs/common';
import { type Client } from 'pg';
import { JobExecutor } from '../../src/shared/jobs/job-executor';
import { JobSignals } from '../../src/shared/jobs/job-queue';
import { JobRepository } from '../../src/shared/jobs/job.repository';
import { connectTestClient, testDb } from '../db/connect';

jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);

/** Counts claimNext and nextDue calls made by the executor (lead review: ~1,000 queries/s before the fix). */
class CountingRepository extends JobRepository {
  claims = 0;
  nextDues = 0;
  override claimNext(...args: Parameters<JobRepository['claimNext']>): ReturnType<JobRepository['claimNext']> {
    this.claims += 1;
    return super.claimNext(...args);
  }
  override msUntilNextDue(...args: Parameters<JobRepository['msUntilNextDue']>): ReturnType<JobRepository['msUntilNextDue']> {
    this.nextDues += 1;
    return super.msUntilNextDue(...args);
  }
}

describe('JobExecutor: no hot loop while a type is saturated (integration)', () => {
  let client: Client;

  beforeAll(async () => {
    client = await connectTestClient();
  });

  afterAll(async () => {
    await client.end();
  });

  it('stays quiet while 3 due jobs wait behind concurrency 1, then drains them', async () => {
    const repo = new CountingRepository(testDb(client));
    const executor = new JobExecutor(repo, new JobSignals(), { problemBaseUrl: 'http://localhost:3000' });
    const type = `sat-${randomUUID().slice(0, 8)}`;
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    executor.register({
      type,
      concurrency: 1,
      timeoutMs: 10_000,
      parse: (p) => p,
      run: async () => {
        await gate;
        return { resultRef: '/ok' };
      },
    });
    const past = new Date(Date.now() - 1000);
    for (let i = 0; i < 3; i += 1) await repo.enqueue({ type, idempotencyKey: randomUUID(), payload: {}, runAfter: past });

    await executor.start();
    const claimsAtStart = repo.claims;
    const nextDuesAtStart = repo.nextDues;
    await new Promise((r) => setTimeout(r, 1_000));

    // One job runs; the other two are due but blocked by the slot. No timer may spin on them.
    expect(repo.claims - claimsAtStart).toBe(0);
    expect(repo.nextDues - nextDuesAtStart).toBe(0);
    expect(claimsAtStart).toBeLessThanOrEqual(3);

    release();
    await executor.idle();
    await executor.stop();
    expect(repo.claims).toBeLessThan(15);
  });
});
