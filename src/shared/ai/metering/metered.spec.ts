import { z } from 'zod';
import { AiCallError } from '../errors';
import { type CallRecord, type StructuredGenerator, type StructuredRequest, type StructuredResult } from '../ports';
import { type LlmCallEntry, type LlmCallRecorder } from './llm-call.recorder';
import { MeteredEmbedder, MeteredStructuredGenerator } from './metered';

const call = (model: string): CallRecord => ({
  provider: model.startsWith('claude') ? 'anthropic' : 'google',
  model,
  usage: { inputTokens: 1_000_000, cacheWriteTokens: 0, cacheReadTokens: 0, outputTokens: 0 },
  latencyMs: 42,
});

const NOW = new Date('2026-10-21T10:00:00Z');

class FakeRecorder implements LlmCallRecorder {
  entries: LlmCallEntry[] = [];
  fail = false;
  record(entry: LlmCallEntry): Promise<void> {
    if (this.fail) return Promise.reject(new Error('db down'));
    this.entries.push(entry);
    return Promise.resolve();
  }
}

const request = (model: 'claude-sonnet-5-5' | 'gemini-3.5-flash-lite'): StructuredRequest<{ ok: boolean }> => ({
  stage: 'design',
  model,
  prompt: { name: 'path-designer', version: 'v1', text: 'x' },
  input: 'y',
  schema: z.object({ ok: z.boolean() }),
  jobId: '11111111-1111-4111-8111-111111111111',
});

function setup(outcome: (model: string) => Promise<unknown>) {
  const recorder = new FakeRecorder();
  const make = (): StructuredGenerator => ({
    generate: <T,>(req: StructuredRequest<T>) => outcome(req.model) as Promise<StructuredResult<T>>,
  });
  const anthropic = make();
  const google = make();
  return { recorder, generator: new MeteredStructuredGenerator({ anthropic, google }, recorder, () => 0, () => NOW) };
}

describe('MeteredStructuredGenerator', () => {
  it('routes by model provider and records a priced ok row', async () => {
    const t = setup((model) => Promise.resolve({ output: { ok: true }, call: call(model) }));

    await t.generator.generate(request('claude-sonnet-5-5'));

    expect(t.recorder.entries).toEqual([
      {
        stage: 'design',
        provider: 'anthropic',
        model: 'claude-sonnet-5-5',
        promptName: 'path-designer',
        promptVersion: 'v1',
        usage: call('claude-sonnet-5-5').usage,
        costUsd: 2,
        latencyMs: 42,
        status: 'ok',
        failure: null,
        jobId: '11111111-1111-4111-8111-111111111111',
      },
    ]);
  });

  it('records a refusal with its billed usage and rethrows', async () => {
    const t = setup((model) => Promise.reject(new AiCallError('refused', 'no', undefined, call(model))));

    await expect(t.generator.generate(request('gemini-3.5-flash-lite'))).rejects.toMatchObject({ failure: 'refused' });
    expect(t.recorder.entries[0]).toMatchObject({ provider: 'google', status: 'refused', failure: 'refused', costUsd: 0.3 });
  });

  it.each([
    ['rate_limited', 'error'],
    ['billing', 'error'],
    ['timeout', 'timeout'],
    ['invalid_output', 'invalid_output'],
  ] as const)('records a %s failure without a reply as a zero-cost %s row', async (failure, status) => {
    const t = setup(() => Promise.reject(new AiCallError(failure, 'x')));

    await expect(t.generator.generate(request('claude-sonnet-5-5'))).rejects.toMatchObject({ failure });
    expect(t.recorder.entries[0]).toMatchObject({ status, failure, costUsd: 0, usage: { inputTokens: 0, outputTokens: 0 } });
  });

  it('never lets a metering failure break the AI call', async () => {
    const t = setup((model) => Promise.resolve({ output: { ok: true }, call: call(model) }));
    t.recorder.fail = true;

    await expect(t.generator.generate(request('claude-sonnet-5-5'))).resolves.toMatchObject({ output: { ok: true } });
  });
});

describe('MeteredEmbedder', () => {
  it('records embeddings against the embedding model', async () => {
    const recorder = new FakeRecorder();
    const inner = {
      embed: () =>
        Promise.resolve({ vectors: [[0]], model: 'gemini-embedding-2', version: 1, call: call('gemini-embedding-2') }),
    };

    await new MeteredEmbedder(inner, 'gemini-embedding-2', recorder, () => 0, () => NOW).embed({ stage: 'embed', texts: ['a'], kind: 'query' });

    expect(recorder.entries[0]).toMatchObject({ stage: 'embed', provider: 'google', model: 'gemini-embedding-2', costUsd: 0.2, promptName: null });
  });
});
