import { type LlmCallEntry, type LlmCallRecorder } from './llm-call.recorder';
import { TallyingRecorder } from './tallying.recorder';

const entry = (costUsd: number): LlmCallEntry => ({
  stage: 'discover',
  provider: 'anthropic',
  model: 'claude-haiku-5-5',
  promptName: 'web-discovery',
  promptVersion: 'v1',
  usage: { inputTokens: 10, cacheWriteTokens: 0, cacheReadTokens: 0, outputTokens: 5 },
  webSearchRequests: 6,
  costUsd,
  latencyMs: 1,
  status: 'ok',
  failure: null,
  jobId: 'smoke',
  budgetScope: 'operator',
});

describe('TallyingRecorder', () => {
  it('records job_id as null with detachJobs, totals cost and returns each step', async () => {
    const written: LlmCallEntry[] = [];
    const tally = new TallyingRecorder({ record: (e) => (written.push(e), Promise.resolve()) }, { detachJobs: true });

    await tally.record(entry(0.06));
    await tally.record(entry(0.02));

    expect(written.map((e) => e.jobId)).toEqual([null, null]);
    expect(tally.total).toBeCloseTo(0.08, 6);
    expect(tally.take()).toHaveLength(2);
    expect(tally.take()).toEqual([]);
  });

  it('counts and rethrows a failed insert, still counting its cost', async () => {
    const failing: LlmCallRecorder = { record: () => Promise.reject(new Error('22P02 invalid input syntax for type uuid')) };
    const tally = new TallyingRecorder(failing);

    await expect(tally.record(entry(0.05))).rejects.toThrow('22P02');
    expect(tally.failures).toBe(1);
    expect(tally.total).toBeCloseTo(0.05, 6);
  });

  it('keeps rows that failed to record and writes them once the database is back (A8 pilot)', async () => {
    let up = false;
    const written: LlmCallEntry[] = [];
    const flaky: LlmCallRecorder = { record: (e) => (up ? (written.push(e), Promise.resolve()) : Promise.reject(new Error('Connection terminated'))) };
    const tally = new TallyingRecorder(flaky);

    await expect(tally.record(entry(0.05))).rejects.toThrow('Connection terminated');
    await expect(tally.record(entry(0.03))).rejects.toThrow();
    expect(await tally.flushUnrecorded()).toBe(2);
    up = true;
    expect(await tally.flushUnrecorded()).toBe(0);
    expect(written.map((e) => e.costUsd)).toEqual([0.05, 0.03]);
    expect(tally.unrecorded).toEqual([]);
  });
});
