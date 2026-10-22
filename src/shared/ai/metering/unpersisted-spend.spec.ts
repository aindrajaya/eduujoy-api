import { AiBudgetGuard } from '../budget/budget.guard';
import { AiBudgetExceededError } from '../errors';
import { type LlmCallEntry } from './llm-call.recorder';
import { GuardedSpendReader, PersistGuardRecorder, UnpersistedSpend } from './unpersisted-spend';

const NOW = new Date('2026-10-22T10:00:00Z');
const entry = (costUsd: number): LlmCallEntry => ({
  stage: 'analyse',
  provider: 'google',
  model: 'gemini-3.8-flash',
  promptName: 'resource-analyse',
  promptVersion: 'v1',
  usage: { inputTokens: 1, cacheWriteTokens: 0, cacheReadTokens: 0, outputTokens: 1 },
  webSearchRequests: 0,
  costUsd,
  latencyMs: 1,
  status: 'ok',
  failure: null,
  jobId: null,
});

describe('unpersisted spend', () => {
  it('a failed llm_calls insert still blocks a cold start once the tally passes the budget', async () => {
    const unpersisted = new UnpersistedSpend();
    const recorder = new PersistGuardRecorder({ record: () => Promise.reject(new Error('Connection terminated')) }, unpersisted, () => NOW);
    // Persisted spend today: $2.50 of a $3 budget.
    const guard = new AiBudgetGuard(new GuardedSpendReader({ spentSince: () => Promise.resolve(2.5) }, unpersisted), 3, () => NOW);

    await expect(guard.assertCanStart('cold')).resolves.toBeUndefined();
    await expect(recorder.record(entry(0.3))).rejects.toThrow('Connection terminated');
    await expect(guard.assertCanStart('cold')).resolves.toBeUndefined();
    await expect(recorder.record(entry(0.25))).rejects.toThrow();

    // 2.50 persisted + 0.55 unpersisted >= 3: cold work stops; cached work still runs.
    await expect(guard.assertCanStart('cold')).rejects.toBeInstanceOf(AiBudgetExceededError);
    await expect(guard.assertCanStart('cached')).resolves.toBeUndefined();
    expect(unpersisted.count).toBe(2);
  });

  it('counts only spend since the requested time (the UTC day)', () => {
    const unpersisted = new UnpersistedSpend();
    unpersisted.add(1, new Date('2026-10-21T23:00:00Z'));
    unpersisted.add(0.5, NOW);
    expect(unpersisted.totalSince(new Date('2026-10-22T00:00:00Z'))).toBe(0.5);
  });

  it('passes a persisted row through without tallying it', async () => {
    const unpersisted = new UnpersistedSpend();
    const rows: LlmCallEntry[] = [];
    await new PersistGuardRecorder({ record: (e) => (rows.push(e), Promise.resolve()) }, unpersisted).record(entry(0.1));
    expect(rows).toHaveLength(1);
    expect(unpersisted.count).toBe(0);
  });
});
