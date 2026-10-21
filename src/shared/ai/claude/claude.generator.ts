import Anthropic from '@anthropic-ai/sdk';
import { MODELS, type TokenUsage } from '../catalog';
import { AiCallError, classifyStatus } from '../errors';
import { toStructuredSchema } from '../json-schema';
import { type StructuredGenerator, type StructuredRequest, type StructuredResult } from '../ports';
import { UNTRUSTED_DATA_RULE } from '../untrusted';

/** Below the ~16K output threshold where non-streaming requests risk SDK HTTP timeouts. */
const DEFAULT_MAX_TOKENS = 16_000;
/** Server-side refusal fallback (Claude API only); routes by refusal category, no model list to keep. */
const FALLBACK_BETA = 'server-side-fallback-2026-07-01';
const FALLBACK_MODELS = new Set<string>(['claude-sonnet-5-5']);

export function anthropicUsage(usage: Anthropic.Beta.BetaUsage): TokenUsage {
  const cacheWrite = usage.cache_creation_input_tokens ?? 0;
  return {
    inputTokens: usage.input_tokens + cacheWrite,
    cacheWriteTokens: cacheWrite,
    cacheReadTokens: usage.cache_read_input_tokens ?? 0,
    outputTokens: usage.output_tokens,
  };
}

function toAiError(error: unknown): AiCallError {
  if (error instanceof AiCallError) return error;
  if (error instanceof Anthropic.APIConnectionTimeoutError) return new AiCallError('timeout', 'Claude request timed out');
  if (error instanceof Anthropic.APIConnectionError) return new AiCallError('server', 'Could not reach the Claude API');
  if (error instanceof Anthropic.APIError) {
    const status: unknown = error.status;
    const code = typeof status === 'number' ? status : undefined;
    return new AiCallError(classifyStatus(code), `Claude API error ${String(code)}`, code);
  }
  throw error;
}

export class ClaudeStructuredGenerator implements StructuredGenerator {
  constructor(
    private readonly client: Anthropic,
    private readonly now: () => number = () => performance.now(),
  ) {}

  async generate<T>(request: StructuredRequest<T>): Promise<StructuredResult<T>> {
    const spec = MODELS[request.model];
    if (spec.provider !== 'anthropic') throw new Error(`${request.model} is not a Claude model`);
    const fallback = FALLBACK_MODELS.has(request.model);
    const started = this.now();

    let message: Anthropic.Beta.BetaMessage;
    try {
      message = await this.client.beta.messages.create(
        {
          model: request.model,
          max_tokens: request.maxTokens ?? DEFAULT_MAX_TOKENS,
          system: [
            {
              type: 'text',
              text: `${request.prompt.text}\n\n${UNTRUSTED_DATA_RULE}`,
              cache_control: { type: 'ephemeral' },
            },
          ],
          messages: [{ role: 'user', content: request.input }],
          output_config: {
            format: { type: 'json_schema', schema: toStructuredSchema(request.schema) },
            ...(request.effort ? { effort: request.effort } : {}),
          },
          ...(fallback ? { betas: [FALLBACK_BETA], fallbacks: 'default' } : {}),
        },
        { timeout: spec.timeoutMs, maxRetries: 2 },
      );
    } catch (error) {
      throw toAiError(error);
    }

    const call = {
      provider: 'anthropic' as const,
      model: message.model,
      usage: anthropicUsage(message.usage),
      latencyMs: Math.round(this.now() - started),
    };
    if (message.stop_reason === 'refusal') throw new AiCallError('refused', 'Claude declined the request', undefined, call);
    if (message.stop_reason === 'max_tokens') {
      throw new AiCallError('invalid_output', 'Claude output was truncated at max_tokens', undefined, call);
    }

    const text = message.content
      .filter((block): block is Anthropic.Beta.BetaTextBlock => block.type === 'text')
      .map((block) => block.text)
      .join('');
    let json: unknown;
    try {
      json = JSON.parse(text);
    } catch {
      throw new AiCallError('invalid_output', 'Claude returned invalid JSON', undefined, call);
    }
    const parsed = request.schema.safeParse(json);
    if (!parsed.success) {
      throw new AiCallError('invalid_output', `Claude output failed validation: ${parsed.error.message}`, undefined, call);
    }
    return { output: parsed.data, call };
  }
}
