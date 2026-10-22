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
});
