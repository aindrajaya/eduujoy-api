import Anthropic from '@anthropic-ai/sdk';
import { z } from 'zod';
import { ClaudeWebSearcher } from '../../src/shared/ai/claude/claude.web-search';
import { AiCallError } from '../../src/shared/ai/errors';
import { FixtureServer, type FixtureResponse } from './fixture-server';

// Synthetic responses in the documented shape (platform.claude.com web-search-tool, "Response"); the
// live run (`pnpm discovery:smoke`) exercises the real API.
const picks = z.object({ picks: z.array(z.object({ url: z.string(), type: z.enum(['article', 'official_doc', 'related']) })) });
const prompt = { name: 'web-discovery', version: 'v1', text: 'Find learning resources.' };
const request = { stage: 'discover', model: 'claude-haiku-5-5' as const, prompt, input: 'React hooks, novice', maxUses: 6, schema: picks, blockedDomains: ['contentfarm.example'] };

function message(content: unknown[], stopReason: string, searches: number, usage = { input_tokens: 9000, output_tokens: 300 }): FixtureResponse {
  return {
    status: 200,
    contentType: 'application/json',
    body: {
      id: 'msg_web',
      type: 'message',
      role: 'assistant',
      model: 'claude-haiku-5-5',
      content,
      stop_reason: stopReason,
      stop_sequence: null,
      usage: { ...usage, cache_creation_input_tokens: 0, cache_read_input_tokens: 0, server_tool_use: { web_search_requests: searches } },
    },
  };
}

const search = (id: string, query: string) => ({ type: 'server_tool_use', id, name: 'web_search', input: { query } });
const results = (id: string, urls: string[]) => ({
  type: 'web_search_tool_result',
  tool_use_id: id,
  content: urls.map((url) => ({ type: 'web_search_result', url, title: `Title of ${url}`, encrypted_content: 'ENCRYPTED-SECRET', page_age: 'April 30, 2026' })),
});

describe('ClaudeWebSearcher (contract, documented shapes)', () => {
  let server: FixtureServer;
  let searcher: ClaudeWebSearcher;

  beforeEach(async () => {
    server = new FixtureServer();
    searcher = new ClaudeWebSearcher(new Anthropic({ apiKey: 'test-key', baseURL: await server.start() }));
  });

  afterEach(async () => {
    await server.stop();
  });

  it('sends web_search_20260209 as a direct tool and returns hits, queries and the parsed answer', async () => {
    server.enqueue(
      message(
        [
          search('srv_1', 'react hooks tutorial'),
          results('srv_1', ['https://react.dev/learn', 'https://blog.example/hooks']),
          { type: 'text', text: '{"picks":[{"url":"https://react.dev/learn","type":"official_doc"}]}', citations: null },
        ],
        'end_turn',
        1,
      ),
    );

    const result = await searcher.search(request);

    expect(server.received[0]?.body).toMatchObject({
      model: 'claude-haiku-5-5',
      tools: [{ type: 'web_search_20260209', name: 'web_search', max_uses: 6, allowed_callers: ['direct'], blocked_domains: ['contentfarm.example'] }],
      messages: [{ role: 'user', content: 'React hooks, novice' }],
    });
    expect(result.hits).toEqual([
      { url: 'https://react.dev/learn', title: 'Title of https://react.dev/learn', pageAge: 'April 30, 2026' },
      { url: 'https://blog.example/hooks', title: 'Title of https://blog.example/hooks', pageAge: 'April 30, 2026' },
    ]);
    expect(JSON.stringify(result)).not.toContain('ENCRYPTED-SECRET');
    expect(result.queries).toEqual(['react hooks tutorial']);
    expect(result.answer).toEqual({ picks: [{ url: 'https://react.dev/learn', type: 'official_doc' }] });
    expect(result.call).toMatchObject({ webSearchRequests: 1, usage: { inputTokens: 9000, outputTokens: 300 } });
  });

  it('continues a pause_turn by sending the paused content back, and sums usage and searches', async () => {
    const paused = [search('srv_1', 'q1'), results('srv_1', ['https://a.example/1'])];
    server.enqueue(
      message(paused, 'pause_turn', 3),
      message([search('srv_2', 'q2'), results('srv_2', ['https://a.example/1', 'https://b.example/2']), { type: 'text', text: '```json\n{"picks":[]}\n```' }], 'end_turn', 2),
    );

    const result = await searcher.search(request);

    expect(server.received).toHaveLength(2);
    expect((server.received[1]?.body as { messages: unknown[] }).messages).toEqual([
      { role: 'user', content: 'React hooks, novice' },
      { role: 'assistant', content: paused },
    ]);
    expect(result.hits.map((h) => h.url)).toEqual(['https://a.example/1', 'https://b.example/2']);
    expect(result.answer).toEqual({ picks: [] });
    expect(result.call).toMatchObject({ webSearchRequests: 5, usage: { inputTokens: 18000, outputTokens: 600 } });
  });

  it('keeps the hits but no answer when the final text is not valid JSON, or a search errored', async () => {
    server.enqueue(
      message(
        [
          search('srv_1', 'q'),
          { type: 'web_search_tool_result', tool_use_id: 'srv_1', content: { type: 'web_search_tool_result_error', error_code: 'max_uses_exceeded' } },
          search('srv_2', 'q2'),
          results('srv_2', ['https://c.example/3']),
          { type: 'text', text: 'Here are some resources I found.' },
        ],
        'end_turn',
        1,
      ),
    );

    const result = await searcher.search(request);

    expect(result.hits.map((h) => h.url)).toEqual(['https://c.example/3']);
    expect(result.answer).toBeNull();
  });

  it('meters a failure on a continuation with the usage of the turns already billed', async () => {
    server.enqueue(message([search('srv_1', 'q1')], 'pause_turn', 2), { status: 400, contentType: 'application/json', body: { type: 'error', error: { type: 'invalid_request_error', message: 'bad' } } });

    const error = await searcher.search(request).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(AiCallError);
    expect((error as AiCallError).failure).toBe('bad_request');
    expect((error as AiCallError).call).toMatchObject({ webSearchRequests: 2, usage: { inputTokens: 9000 } });
  });

  it('throws refused, with the call, when Claude declines', async () => {
    server.enqueue(message([], 'refusal', 0));

    await expect(searcher.search(request)).rejects.toMatchObject({ failure: 'refused', call: { provider: 'anthropic' } });
  });
});
