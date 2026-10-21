// Models and list prices used for metering (PRD-API §11, master PRD §8). Prices are US$ per 1M tokens.
// `verified: false` marks a price no source in the PRDs or provider docs confirms yet; those are
// conservative stand-ins listed under "Blocked on user" until confirmed.

export type Provider = 'anthropic' | 'google';

export interface ModelSpec {
  id: string;
  provider: Provider;
  input: number;
  output: number;
  cacheRead: number;
  /** Long-prompt tier (Haiku 5.5 bills prompts over 100k tokens at a higher rate). */
  longPrompt?: { aboveInputTokens: number; input: number; output: number };
  timeoutMs: number;
  verified: boolean;
}

export const MODELS = {
  'claude-sonnet-5-5': {
    id: 'claude-sonnet-5-5',
    provider: 'anthropic',
    input: 2,
    output: 10,
    cacheRead: 0.2,
    timeoutMs: 90_000,
    verified: true,
  },
  'claude-haiku-5-5': {
    id: 'claude-haiku-5-5',
    provider: 'anthropic',
    input: 0.1,
    output: 0.5,
    cacheRead: 0.01,
    longPrompt: { aboveInputTokens: 100_000, input: 0.5, output: 2.5 },
    timeoutMs: 20_000,
    verified: false,
  },
  'gemini-3.8-flash': {
    id: 'gemini-3.8-flash',
    provider: 'google',
    input: 0.75,
    output: 3.75,
    cacheRead: 0.75,
    timeoutMs: 180_000,
    verified: false,
  },
  'gemini-3.5-flash-lite': {
    id: 'gemini-3.5-flash-lite',
    provider: 'google',
    input: 0.3,
    output: 2.5,
    cacheRead: 0.3,
    timeoutMs: 30_000,
    verified: false,
  },
  'gemini-embedding-2': {
    id: 'gemini-embedding-2',
    provider: 'google',
    input: 0.15,
    output: 0,
    cacheRead: 0.15,
    timeoutMs: 30_000,
    verified: false,
  },
} as const satisfies Record<string, ModelSpec>;

export type ModelId = keyof typeof MODELS;

/**
 * Server-side refusal fallbacks may answer from a model outside the catalog; meter those at the most
 * expensive current Claude tier so spend is never under-reported.
 */
export const UNKNOWN_MODEL_PRICE: Pick<ModelSpec, 'input' | 'output' | 'cacheRead'> = { input: 10, output: 50, cacheRead: 1 };

export interface TokenUsage {
  /** Uncached input tokens, including tokens written to the prompt cache. */
  inputTokens: number;
  /** Of `inputTokens`, how many were written to the cache (billed at 1.25x input). */
  cacheWriteTokens: number;
  cacheReadTokens: number;
  /** Output tokens, including thinking tokens. */
  outputTokens: number;
}

export function modelSpec(id: string): ModelSpec | undefined {
  return (MODELS as Record<string, ModelSpec>)[id];
}

/** US$ cost of one call, rounded to the llm_calls column's 6 decimals. */
export function costUsd(modelId: string, usage: TokenUsage): number {
  const spec = modelSpec(modelId);
  const base = spec ?? UNKNOWN_MODEL_PRICE;
  const promptTokens = usage.inputTokens + usage.cacheReadTokens;
  const tier = spec?.longPrompt && promptTokens > spec.longPrompt.aboveInputTokens ? spec.longPrompt : undefined;
  const inputRate = tier?.input ?? base.input;
  const outputRate = tier?.output ?? base.output;
  const uncached = usage.inputTokens - usage.cacheWriteTokens;
  const dollars =
    (uncached * inputRate + usage.cacheWriteTokens * inputRate * 1.25 + usage.cacheReadTokens * base.cacheRead) /
      1_000_000 +
    (usage.outputTokens * outputRate) / 1_000_000;
  return Math.round(dollars * 1_000_000) / 1_000_000;
}
