import { z } from 'zod';
import { type AiCallError } from '../../src/shared/ai/errors';
import { createGeminiClient, GeminiEmbedder, GeminiStructuredGenerator } from '../../src/shared/ai/gemini/gemini.adapters';
import { FixtureServer, loadFixture, type FixtureResponse } from './fixture-server';

const topic = z.object({ canonicalName: z.string(), domain: z.enum(['software', 'stem', 'non_technical']) });
const request = {
  stage: 'fixture',
  model: 'gemini-3.5-flash-lite' as const,
  prompt: { name: 'fixture', version: 'v1', text: 'Name the topic.' },
  input: 'react hooks',
  schema: topic,
  maxTokens: 512,
};
const apiError = (status: number, code: string): FixtureResponse => ({
  status,
  contentType: 'application/json',
  body: { error: { code: status, message: code, status: code } },
});

describe('Gemini adapters (contract, synthetic fixtures until re-recorded)', () => {
  let server: FixtureServer;
  let sleeps: number[];
  let generator: GeminiStructuredGenerator;
  let embedder: GeminiEmbedder;

  beforeEach(async () => {
    server = new FixtureServer();
    const client = createGeminiClient('test-key', { baseUrl: await server.start(), fetch: globalThis.fetch });
    sleeps = [];
    const sleep = (ms: number): Promise<void> => {
      sleeps.push(ms);
      return Promise.resolve();
    };
    generator = new GeminiStructuredGenerator(client, { sleep });
    embedder = new GeminiEmbedder(client, { sleep });
  });

  afterEach(async () => {
    await server.stop();
  });

  it('requests JSON with the schema and maps usage, counting thinking tokens as output', async () => {
    server.enqueue(loadFixture('gemini-3.5-flash-lite.structured').response);

    const result = await generator.generate(request);

    expect(result.output).toEqual({ canonicalName: 'React Hooks', domain: 'software' });
    expect(result.call.usage).toEqual({ inputTokens: 32, cacheWriteTokens: 0, cacheReadTokens: 10, outputTokens: 20 });
    const sent = server.received[0];
    expect(sent?.path).toContain('/models/gemini-3.5-flash-lite:generateContent');
    expect(sent?.body).toMatchObject({
      systemInstruction: { parts: [{ text: expect.stringContaining('Name the topic.') as string }] },
      generationConfig: {
        responseMimeType: 'application/json',
        maxOutputTokens: 512,
        responseJsonSchema: { type: 'object', additionalProperties: false },
      },
    });
  });

  it('retries 429 and 503 with growing jittered delays, then succeeds', async () => {
    server.enqueue(apiError(429, 'RESOURCE_EXHAUSTED'), apiError(503, 'UNAVAILABLE'), loadFixture('gemini-3.5-flash-lite.structured').response);

    await expect(generator.generate(request)).resolves.toBeDefined();
    expect(server.received).toHaveLength(3);
    expect(sleeps).toHaveLength(2);
    expect(sleeps[1]).toBeGreaterThan(sleeps[0] ?? 0);
  });

  it.each([
    [400, 'INVALID_ARGUMENT', 'bad_request'],
    [402, 'RESOURCE_EXHAUSTED', 'billing'],
  ])('does not retry HTTP %i (%s)', async (status, code, failure) => {
    server.enqueue(apiError(status, code));

    await expect(generator.generate(request)).rejects.toMatchObject({ failure, retryable: false });
    expect(server.received).toHaveLength(1);
  });

  it('maps a safety block to refused, keeping the billed usage', async () => {
    const fixture = loadFixture('gemini-3.5-flash-lite.structured').response;
    const body = structuredClone(fixture.body) as { candidates: { finishReason: string }[] };
    body.candidates[0] = { ...body.candidates[0], finishReason: 'SAFETY' };
    server.enqueue({ ...fixture, body });

    const error = (await generator.generate(request).catch((e: unknown) => e)) as AiCallError;
    expect(error).toMatchObject({ failure: 'refused' });
    expect(error.call?.usage.inputTokens).toBe(32);
  });

  it('batches one request per text at 768 dimensions, with document prefixes and no task_type', async () => {
    server.enqueue(loadFixture('gemini-embedding-2.embed').response);

    const result = await embedder.embed({
      stage: 'embed',
      texts: ['Managing state in function components', 'Vectors and matrices'],
      kind: 'document',
      titles: ['React hooks', null],
    });

    expect(result.vectors).toHaveLength(2);
    expect(result.vectors.every((v) => v.length === 768)).toBe(true);
    expect(result).toMatchObject({ model: 'gemini-embedding-2', version: 1 });
    const sent = server.received[0];
    expect(sent?.path).toContain('/models/gemini-embedding-2:batchEmbedContents');
    const requests = (sent?.body as { requests: { content: { parts: { text: string }[] }; outputDimensionality?: number }[] }).requests;
    // Two separate requests, each a single-part content: the API returns one embedding per request.
    expect(requests).toHaveLength(2);
    expect(requests.map((r) => r.content.parts.map((p) => p.text))).toEqual([
      ['title: React hooks | text: Managing state in function components'],
      ['title: none | text: Vectors and matrices'],
    ]);
    expect(requests.every((r) => r.outputDimensionality === 768)).toBe(true);
    expect(JSON.stringify(sent?.body)).not.toMatch(/taskType|task_type/);
  });

  it('prefixes queries for asymmetric search retrieval', async () => {
    server.enqueue({
      ...loadFixture('gemini-embedding-2.embed').response,
      body: { embeddings: [(loadFixture('gemini-embedding-2.embed').response.body as { embeddings: unknown[] }).embeddings[0]] },
    });

    await embedder.embed({ stage: 'resolve', texts: ['react hooks'], kind: 'query' });

    const requests = (server.received[0]?.body as { requests: { content: { parts: { text: string }[] } }[] }).requests;
    expect(requests.map((r) => r.content.parts[0]?.text)).toEqual(['task: search result | query: react hooks']);
  });

  it('rejects an embedding reply with the wrong vector count', async () => {
    const fixture = loadFixture('gemini-embedding-2.embed').response;
    const body = structuredClone(fixture.body) as { embeddings: unknown[] };
    body.embeddings.pop();
    server.enqueue({ ...fixture, body });

    await expect(embedder.embed({ stage: 'embed', texts: ['a', 'b'], kind: 'query' })).rejects.toMatchObject({
      failure: 'invalid_output',
    });
  });
});
