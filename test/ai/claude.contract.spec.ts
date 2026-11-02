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

  it('sends no keyword Claude rejects, restates the bound, and fails a reply that breaks it as metered invalid output', async () => {
    // Claude 400s on maxItems and numeric bounds (2 Nov 2026); Zod still enforces them on the reply.
    const tags = z.object({ tags: z.array(z.string()).max(2), score: z.number().int().min(1).max(5) });
    server.enqueue(
      edited('claude-haiku-5-5.structured', (body) => {
        body['content'] = [{ type: 'text', text: JSON.stringify({ tags: ['a', 'b', 'c'], score: 3 }) }];
      }),
    );

    const error = (await generator.generate({ ...request('claude-haiku-5-5'), schema: tags }).catch((e: unknown) => e)) as AiCallError;

    const sent = server.received[0]?.body as { output_config: { format: { schema: { properties: Record<string, Record<string, unknown>> } } } };
    const schema = sent.output_config.format.schema;
    expect(schema.properties['tags']).not.toHaveProperty('maxItems');
    expect(schema.properties['tags']?.['description']).toBe('At most 2 items.');
    expect(schema.properties['score']).not.toHaveProperty('minimum');
    expect(schema.properties['score']?.['description']).toBe('Integer from 1 to 5.');
    expect(error).toBeInstanceOf(AiCallError);
    expect(error).toMatchObject({ failure: 'invalid_output', retryable: false });
    expect(error.message).toMatch(/failed validation/);
    // The billed usage travels with the error, so metering records the call's cost.
    expect(error.call?.usage.outputTokens).toBeGreaterThan(0);
    // Not retried inside the call (PRD-API §11): one request only.
    expect(server.received).toHaveLength(1);
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

  it('refuses video input without calling the API (video analysis is Gemini only)', async () => {
    await expect(generator.generate({ ...request('claude-haiku-5-5'), media: { youtubeUrl: 'https://www.youtube.com/watch?v=x' } })).rejects.toThrow(
      'Claude does not take video input',
    );
    expect(server.received).toHaveLength(0);
  });
});

