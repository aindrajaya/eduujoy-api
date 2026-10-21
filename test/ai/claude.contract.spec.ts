import Anthropic from '@anthropic-ai/sdk';
import { z } from 'zod';
import { ClaudeStructuredGenerator } from '../../src/shared/ai/claude/claude.generator';
import { AiCallError } from '../../src/shared/ai/errors';
import { UNTRUSTED_DATA_RULE } from '../../src/shared/ai/untrusted';
import { FixtureServer, loadFixture, type FixtureResponse } from './fixture-server';

const topic = z.object({ canonicalName: z.string(), domain: z.enum(['software', 'stem', 'non_technical']) });
const prompt = { name: 'fixture', version: 'v1', text: 'Name the canonical topic for the learner phrase and its domain.' };
const request = (model: 'claude-haiku-5-5' | 'claude-sonnet-5-5') => ({
  stage: 'fixture',
  model,
  prompt,
  input: 'react hooks',
  schema: topic,
  maxTokens: 1024,
});

/** A recorded response with its body edited, e.g. to simulate a refusal. */
function edited(name: string, edit: (body: Record<string, unknown>) => void): FixtureResponse {
  const response = loadFixture(name).response;
  const body = structuredClone(response.body) as Record<string, unknown>;
  edit(body);
  return { ...response, body };
}

describe('ClaudeStructuredGenerator (contract, recorded fixtures)', () => {
  let server: FixtureServer;
  let generator: ClaudeStructuredGenerator;

  beforeEach(async () => {
    server = new FixtureServer();
    const baseURL = await server.start();
    generator = new ClaudeStructuredGenerator(new Anthropic({ apiKey: 'test-key', baseURL }));
  });

  afterEach(async () => {
    await server.stop();
  });

  it('sends a cached system prompt and a closed JSON schema, and parses the recorded Haiku reply', async () => {
    server.enqueue(loadFixture('claude-haiku-5-5.structured').response);

    const result = await generator.generate(request('claude-haiku-5-5'));

    expect(result.output).toEqual({ canonicalName: 'React Hooks', domain: 'software' });
    expect(result.call).toMatchObject({
      provider: 'anthropic',
      model: 'claude-haiku-5-5',
      usage: { inputTokens: 315, cacheWriteTokens: 0, cacheReadTokens: 0, outputTokens: 24 },
    });
    const sent = server.received[0];
    expect(sent?.path).toBe('/v1/messages?beta=true');
    expect(sent?.body).toMatchObject({
      model: 'claude-haiku-5-5',
      max_tokens: 1024,
      system: [{ type: 'text', text: `${prompt.text}\n\n${UNTRUSTED_DATA_RULE}`, cache_control: { type: 'ephemeral' } }],
      messages: [{ role: 'user', content: 'react hooks' }],
      output_config: { format: { type: 'json_schema', schema: { type: 'object', additionalProperties: false } } },
    });
    expect(sent?.body).not.toHaveProperty('fallbacks');
  });

  it('enables server-side refusal fallbacks on Sonnet 5.5', async () => {
    server.enqueue(loadFixture('claude-sonnet-5-5.structured').response);

    await generator.generate(request('claude-sonnet-5-5'));

    expect(server.received[0]?.body).toMatchObject({ fallbacks: 'default' });
    expect(String(server.received[0]?.headers['anthropic-beta'])).toContain('server-side-fallback-2026-07-01');
  });

  it('maps a refusal to a non-retryable error that still carries the billed usage', async () => {
    server.enqueue(edited('claude-haiku-5-5.structured', (b) => (b.stop_reason = 'refusal')));

    const error = (await generator.generate(request('claude-haiku-5-5')).catch((e: unknown) => e)) as AiCallError;

    expect(error).toBeInstanceOf(AiCallError);
    expect(error).toMatchObject({ failure: 'refused', retryable: false });
    expect(error.call?.usage.outputTokens).toBe(24);
  });

  it.each([
    ['invalid JSON', (b: Record<string, unknown>) => (b.content = [{ type: 'text', text: '{not json' }])],
    ['a schema mismatch', (b: Record<string, unknown>) => (b.content = [{ type: 'text', text: '{"canonicalName":1}' }])],
    ['truncation at max_tokens', (b: Record<string, unknown>) => (b.stop_reason = 'max_tokens')],
  ])('maps %s to invalid_output', async (_label, edit) => {
    server.enqueue(edited('claude-haiku-5-5.structured', edit));

    await expect(generator.generate(request('claude-haiku-5-5'))).rejects.toMatchObject({ failure: 'invalid_output' });
  });

  it('retries a 429 and succeeds', async () => {
    server.enqueue(
      { status: 429, contentType: 'application/json', headers: { 'retry-after-ms': '0' }, body: { type: 'error', error: { type: 'rate_limit_error', message: 'slow down' } } },
      loadFixture('claude-haiku-5-5.structured').response,
    );

    await expect(generator.generate(request('claude-haiku-5-5'))).resolves.toBeDefined();
    expect(server.received).toHaveLength(2);
  });

  it('does not retry a 400', async () => {
    server.enqueue({ status: 400, contentType: 'application/json', body: { type: 'error', error: { type: 'invalid_request_error', message: 'bad' } } });

    await expect(generator.generate(request('claude-haiku-5-5'))).rejects.toMatchObject({ failure: 'bad_request', status: 400 });
    expect(server.received).toHaveLength(1);
  });
});
