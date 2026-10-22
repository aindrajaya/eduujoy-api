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

describe('Gemini adapters (contract: recorded generateContent, synthetic embeddings until re-recorded)', () => {
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
    // Pinned jitter: the delays below are exact, so the test can't flake on Math.random.
    generator = new GeminiStructuredGenerator(client, { sleep, random: () => 0.5 });
    embedder = new GeminiEmbedder(client, { sleep, random: () => 0.5 });
  });

  afterEach(async () => {
    await server.stop();
  });

  it('requests JSON with the schema and parses the recorded reply', async () => {
    server.enqueue(loadFixture('gemini-3.5-flash-lite.structured').response);

    const result = await generator.generate(request);

    expect(result.output).toEqual({ canonicalName: 'React Hooks', domain: 'software' });
    expect(result.call.usage).toEqual({ inputTokens: 38, cacheWriteTokens: 0, cacheReadTokens: 0, outputTokens: 21 });
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

  it('maps cached prompt tokens to cache reads and counts thinking tokens as output', async () => {
    const fixture = loadFixture('gemini-3.5-flash-lite.structured').response;
    const body = structuredClone(fixture.body) as { usageMetadata: Record<string, number> };
    body.usageMetadata = { ...body.usageMetadata, promptTokenCount: 38, cachedContentTokenCount: 10, candidatesTokenCount: 21, thoughtsTokenCount: 6 };
    server.enqueue({ ...fixture, body });

    const result = await generator.generate(request);

    expect(result.call.usage).toEqual({ inputTokens: 28, cacheWriteTokens: 0, cacheReadTokens: 10, outputTokens: 27 });
  });

  it('retries 429 and 503 with growing jittered delays, then succeeds', async () => {
    server.enqueue(apiError(429, 'RESOURCE_EXHAUSTED'), apiError(503, 'UNAVAILABLE'), loadFixture('gemini-3.5-flash-lite.structured').response);

    await expect(generator.generate(request)).resolves.toBeDefined();
    expect(server.received).toHaveLength(3);
    // base 500 ms × 2^attempt × (0.5 + 0.5): 500 then 1000.
    expect(sleeps).toEqual([500, 1000]);
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
    expect(error.call?.usage.inputTokens).toBe(38);
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

  describe('YouTube video input (synthetic stream in the documented SSE shape)', () => {
    const chunk = (body: unknown) => `data: ${JSON.stringify(body)}\r\n\r\n`;
    const stream = (parts: string[], finishReason = 'STOP'): FixtureResponse => ({
      status: 200,
      contentType: 'text/event-stream',
      raw: true,
      body: parts
        .map((text, i) =>
          chunk({
            candidates: [{ content: { role: 'model', parts: [{ text }] }, ...(i === parts.length - 1 ? { finishReason } : {}) }],
            modelVersion: 'gemini-3.8-flash',
            ...(i === parts.length - 1 ? { usageMetadata: { promptTokenCount: 31000, candidatesTokenCount: 900, thoughtsTokenCount: 100 } } : {}),
          }),
        )
        .join(''),
    });
    const video = { ...request, model: 'gemini-3.8-flash' as const, media: { youtubeUrl: 'https://www.youtube.com/watch?v=abc123DEF45' } };

    it('streams with the URL as file data at low media resolution, and joins the chunks', async () => {
      server.enqueue(stream(['{"canonicalName":"React', ' Hooks","domain":"software"}']));

      const result = await generator.generate(video);

      expect(result.output).toEqual({ canonicalName: 'React Hooks', domain: 'software' });
      expect(result.call).toMatchObject({ model: 'gemini-3.8-flash', usage: { inputTokens: 31000, outputTokens: 1000 } });
      const sent = server.received[0];
      expect(sent?.path).toContain('/models/gemini-3.8-flash:streamGenerateContent');
      expect(sent?.body).toMatchObject({
        contents: [{ role: 'user', parts: [{ fileData: { fileUri: 'https://www.youtube.com/watch?v=abc123DEF45' } }, { text: 'react hooks' }] }],
        generationConfig: { mediaResolution: 'MEDIA_RESOLUTION_LOW', responseMimeType: 'application/json' },
      });
    });

    it('reports a truncated stream as invalid output, with its usage', async () => {
      server.enqueue(stream(['{"canonicalName":"Re'], 'MAX_TOKENS'));

      await expect(generator.generate(video)).rejects.toMatchObject({ failure: 'invalid_output', call: { usage: { inputTokens: 31000 } } });
    });
  });
});

