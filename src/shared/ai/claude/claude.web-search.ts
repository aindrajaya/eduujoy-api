import type Anthropic from '@anthropic-ai/sdk';
import { type ZodType } from 'zod';
import { MODELS, type TokenUsage } from '../catalog';
import { AiCallError } from '../errors';
import { type CallRecord, type WebSearcher, type WebSearchHit, type WebSearchRequest, type WebSearchResult } from '../ports';
import { UNTRUSTED_DATA_RULE } from '../untrusted';
import { anthropicUsage, toAiError } from './claude.generator';

/**
 * PRD-API §11: `web_search_20260209` or newer. Called directly (`allowed_callers: ["direct"]`): dynamic
 * filtering would route searches through code execution, which not every model supports (the API then
 * answers 400), and direct calls keep the block shapes and the cost predictable.
 */
export const WEB_SEARCH_TOOL = 'web_search_20260209';
/** Six server-side searches don't fit the generic 20 s Haiku timeout; the discover job allows 120 s. */
export const WEB_SEARCH_TIMEOUT_MS = 90_000;
/** Long search turns come back as `pause_turn`; continue them this many times at most. */
const MAX_CONTINUATIONS = 2;
const DEFAULT_MAX_TOKENS = 4_000;

const NO_USAGE: TokenUsage = { inputTokens: 0, cacheWriteTokens: 0, cacheReadTokens: 0, outputTokens: 0 };

function addUsage(a: TokenUsage, b: TokenUsage): TokenUsage {
  return {
    inputTokens: a.inputTokens + b.inputTokens,
    cacheWriteTokens: a.cacheWriteTokens + b.cacheWriteTokens,
    cacheReadTokens: a.cacheReadTokens + b.cacheReadTokens,
    outputTokens: a.outputTokens + b.outputTokens,
  };
}

/** The final answer is a JSON object; tolerate a fenced block or prose around it. */
export function extractJson(text: string): unknown {
  const trimmed = text.trim();
  const candidates = [trimmed, /```(?:json)?\s*([\s\S]*?)```/.exec(trimmed)?.[1] ?? '', trimmed.slice(trimmed.indexOf('{'), trimmed.lastIndexOf('}') + 1)];
  for (const candidate of candidates) {
    if (!candidate) continue;
    try {
      return JSON.parse(candidate) as unknown;
    } catch {
      // try the next shape
    }
  }
  return undefined;
}

export class ClaudeWebSearcher implements WebSearcher {
  constructor(
    private readonly client: Anthropic,
    private readonly now: () => number = () => performance.now(),
  ) {}

  async search<T>(request: WebSearchRequest & { schema: ZodType<T> }): Promise<WebSearchResult<T>> {
    if (MODELS[request.model].provider !== 'anthropic') throw new Error(`${request.model} is not a Claude model`);
    const started = this.now();
    const tool: Anthropic.WebSearchTool20260209 = {
      type: WEB_SEARCH_TOOL,
      name: 'web_search',
      max_uses: request.maxUses,
      allowed_callers: ['direct'],
      ...(request.blockedDomains?.length ? { blocked_domains: request.blockedDomains } : {}),
    };
    const messages: Anthropic.MessageParam[] = [{ role: 'user', content: request.input }];

    let usage = NO_USAGE;
    let searches = 0;
    let model: string = request.model;
    const hits = new Map<string, WebSearchHit>();
    const queries: string[] = [];
    const call = (): CallRecord => ({
      provider: 'anthropic',
      model,
      usage,
      webSearchRequests: searches,
      latencyMs: Math.round(this.now() - started),
    });

    for (let turn = 0; ; turn += 1) {
      let message: Anthropic.Message;
      try {
        message = await this.client.messages.create(
          {
            model: request.model,
            max_tokens: request.maxTokens ?? DEFAULT_MAX_TOKENS,
            system: [{ type: 'text', text: `${request.prompt.text}\n\n${UNTRUSTED_DATA_RULE}`, cache_control: { type: 'ephemeral' } }],
            messages,
            tools: [tool],
          },
          { timeout: WEB_SEARCH_TIMEOUT_MS, maxRetries: 2, ...(request.signal ? { signal: request.signal } : {}) },
        );
      } catch (error) {
        const failure = toAiError(error);
        // Earlier turns of this call were billed; keep their usage on the error so it is metered.
        throw turn === 0 ? failure : new AiCallError(failure.failure, failure.message, failure.status, call());
      }

      model = message.model;
      usage = addUsage(usage, anthropicUsage(message.usage));
      searches += message.usage.server_tool_use?.web_search_requests ?? 0;
      for (const block of message.content) {
        if (block.type === 'server_tool_use' && block.name === 'web_search') {
          const query = (block.input as { query?: unknown } | null)?.query;
          if (typeof query === 'string') queries.push(query);
        }
        if (block.type === 'web_search_tool_result' && Array.isArray(block.content)) {
          for (const result of block.content) {
            // encrypted_content is dropped here: it is never stored or logged (PRD-API §11).
            if (!hits.has(result.url)) hits.set(result.url, { url: result.url, title: result.title, pageAge: result.page_age ?? null });
          }
        }
      }

      if (message.stop_reason === 'pause_turn' && turn < MAX_CONTINUATIONS) {
        messages.push({ role: 'assistant', content: message.content });
        continue;
      }
      if (message.stop_reason === 'refusal') throw new AiCallError('refused', 'Claude declined the search', undefined, call());

      const text = message.content
        .filter((block): block is Anthropic.TextBlock => block.type === 'text')
        .map((block) => block.text)
        .join('');
      // A truncated or malformed answer still leaves the search results, which the caller can use.
      const parsed = message.stop_reason === 'max_tokens' ? undefined : request.schema.safeParse(extractJson(text));
      return { hits: [...hits.values()], answer: parsed?.success ? parsed.data : null, queries, call: call() };
    }
  }
}
