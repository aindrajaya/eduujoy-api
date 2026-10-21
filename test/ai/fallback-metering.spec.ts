import Anthropic from '@anthropic-ai/sdk';
import { z } from 'zod';
import { costUsd, UNKNOWN_MODEL_PRICE } from '../../src/shared/ai/catalog';
import { ClaudeStructuredGenerator } from '../../src/shared/ai/claude/claude.generator';
import { type LlmCallEntry, type LlmCallRecorder } from '../../src/shared/ai/metering/llm-call.recorder';
import { MeteredStructuredGenerator } from '../../src/shared/ai/metering/metered';
import { type StructuredGenerator } from '../../src/shared/ai/ports';
import { FixtureServer, loadFixture } from './fixture-server';

const NOW = new Date('2026-10-21T10:00:00Z');

/**
 * The recorded Sonnet reply, edited into a fallback turn: the Sonnet attempt (model: null) was refused
 * and an Opus attempt answered. Both attempts are billed, so both must be metered.
 */
function fallbackTurn(): ReturnType<typeof loadFixture>['response'] {
  const response = loadFixture('claude-sonnet-5-5.structured').response;
  const body = structuredClone(response.body) as Record<string, unknown>;
  body.model = 'claude-opus-5-5';
  body.content = [
    { type: 'fallback', from: { model: 'claude-sonnet-5-5' }, to: { model: 'claude-opus-5-5' } },
    { type: 'text', text: '{"canonicalName":"React Hooks","domain":"software"}' },
  ];
  body.usage = {
    input_tokens: 630,
    output_tokens: 29,
    cache_creation_input_tokens: 0,
    cache_read_input_tokens: 0,
    iterations: [
      { type: 'message', model: null, input_tokens: 315, output_tokens: 5, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
      {
        type: 'fallback_message',
        model: 'claude-opus-5-5',
        input_tokens: 315,
        output_tokens: 24,
        cache_read_input_tokens: 100,
        cache_creation_input_tokens: 0,
      },
    ],
  };
  return { ...response, body };
}

describe('fallback metering (contract fixture)', () => {
  let server: FixtureServer;
  const entries: LlmCallEntry[] = [];
  const recorder: LlmCallRecorder = {
    record: (entry) => {
      entries.push(entry);
      return Promise.resolve();
    },
  };

  beforeEach(() => {
    server = new FixtureServer();
    entries.length = 0;
  });

  afterEach(async () => {
    await server.stop();
  });

  it('meters the refused Sonnet attempt and the fallback attempt, each at its own price', async () => {
    const claude = new ClaudeStructuredGenerator(new Anthropic({ apiKey: 'test-key', baseURL: await server.start() }));
    const unused: StructuredGenerator = { generate: () => Promise.reject(new Error('not used')) };
    const metered = new MeteredStructuredGenerator({ anthropic: claude, google: unused }, recorder, () => 0, () => NOW);
    server.enqueue(fallbackTurn());

    const result = await metered.generate({
      stage: 'design',
      model: 'claude-sonnet-5-5',
      prompt: { name: 'fixture', version: 'v1', text: 'x' },
      input: 'react hooks',
      schema: z.object({ canonicalName: z.string(), domain: z.string() }),
    });

    const sonnet = costUsd('claude-sonnet-5-5', { inputTokens: 315, cacheWriteTokens: 0, cacheReadTokens: 0, outputTokens: 5 }, NOW);
    const opus = (315 * UNKNOWN_MODEL_PRICE.input + 100 * UNKNOWN_MODEL_PRICE.cacheRead + 24 * UNKNOWN_MODEL_PRICE.output) / 1_000_000;
    expect(result.output.canonicalName).toBe('React Hooks');
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({
      status: 'ok',
      model: 'claude-opus-5-5',
      usage: { inputTokens: 630, cacheReadTokens: 100, outputTokens: 29, cacheWriteTokens: 0 },
    });
    expect(entries[0]?.costUsd).toBeCloseTo(sonnet + opus, 6);
    expect(sonnet).toBeGreaterThan(0);
  });
});
