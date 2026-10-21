import { eq } from 'drizzle-orm';
import { type Client } from 'pg';
import { DrizzleSpendReader } from '../../src/shared/ai/budget/drizzle-spend.reader';
import { DrizzleLlmCallRecorder } from '../../src/shared/ai/metering/llm-call.recorder';
import { llmCalls } from '../../src/shared/db/schema/ai';
import { connectTestClient, testDb, type TestDb } from '../db/connect';

describe('DrizzleLlmCallRecorder (integration)', () => {
  let client: Client;
  let db: TestDb;

  beforeAll(async () => {
    client = await connectTestClient();
    db = testDb(client);
  });

  afterAll(async () => {
    await client.end();
  });

  it('stores a refused call with its failure, tokens and 6-decimal cost', async () => {
    await new DrizzleLlmCallRecorder(db).record({
      stage: 'int-metering',
      provider: 'anthropic',
      model: 'claude-sonnet-5-5',
      promptName: 'path-designer',
      promptVersion: 'v1',
      usage: { inputTokens: 1200, cacheWriteTokens: 0, cacheReadTokens: 300, outputTokens: 40 },
      costUsd: 0.002860,
      latencyMs: 812,
      status: 'refused',
      failure: 'refused',
      jobId: null,
    });

    const [row] = await db.select().from(llmCalls).where(eq(llmCalls.stage, 'int-metering'));
    expect(row).toMatchObject({
      provider: 'anthropic',
      status: 'refused',
      failure: 'refused',
      inputTokens: 1200,
      cacheReadTokens: 300,
      outputTokens: 40,
      costUsd: '0.002860',
      latencyMs: 812,
    });
  });
});

describe('DrizzleSpendReader (integration)', () => {
  it('sums cost_usd since a point in time', async () => {
    const client = await connectTestClient();
    const db = testDb(client);
    try {
      const reader = new DrizzleSpendReader(db);
      const before = await reader.spentSince(new Date(Date.now() - 60_000));
      const base = { stage: 'int-spend', provider: 'google' as const, model: 'gemini-3.5-flash-lite', latencyMs: 1, status: 'ok' as const };
      await db.insert(llmCalls).values([
        { ...base, costUsd: '0.125000' },
        { ...base, costUsd: '0.375000' },
        { ...base, costUsd: '9.000000', createdAt: new Date(Date.now() - 2 * 86_400_000) },
      ]);

      await expect(reader.spentSince(new Date(Date.now() - 60_000))).resolves.toBeCloseTo(before + 0.5, 6);
    } finally {
      await client.end();
    }
  });
});
