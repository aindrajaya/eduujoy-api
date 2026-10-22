// Models and list prices used for metering (PRD-API §11, master PRD §8). Prices are US$ per 1M tokens,
// checked by the lead against platform.claude.com/docs/en/about-claude/pricing and
// ai.google.dev/gemini-api/docs/pricing (A4 review, 21 Oct 2026).

export type Provider = 'anthropic' | 'google';

export interface Rates {
  input: number;
  output: number;
  cacheRead: number;
}

export interface ModelSpec extends Rates {
  id: string;
  provider: Provider;
  /** Long-prompt tier (Haiku 5.5 bills prompts over 100k tokens at higher rates, cache reads included). */
  longPrompt?: Rates & { aboveInputTokens: number };
  /** Effective-dated price changes, oldest first; each applies from its ISO instant onward. */
  priceChanges?: (Rates & { from: string })[];
  timeoutMs: number;
  verified: boolean;
}

export const MODELS = {
  'claude-sonnet-5-5': {
    id: 'claude-sonnet-5-5',
    provider: 'anthropic',
    input: 2,
    output: 10,
    cacheRead: 0.1,
    timeoutMs: 90_000,
    verified: true,
  },
  'claude-haiku-5-5': {
    id: 'claude-haiku-5-5',
    provider: 'anthropic',
    input: 0.1,
    output: 0.5,
    cacheRead: 0.01,
    longPrompt: { aboveInputTokens: 100_000, input: 0.5, output: 2.5, cacheRead: 0.05 },
    timeoutMs: 20_000,
    verified: true,
  },
  'gemini-3.8-flash': {
    id: 'gemini-3.8-flash',
    provider: 'google',
    input: 0.75,
    output: 3.75,
    cacheRead: 0.075,
    priceChanges: [{ from: '2027-01-01T00:00:00Z', input: 1.5, output: 7.5, cacheRead: 0.15 }],
    timeoutMs: 180_000,
    verified: true,
  },
  'gemini-3.5-flash-lite': {
    id: 'gemini-3.5-flash-lite',
    provider: 'google',
    input: 0.3,
    output: 2.5,
    cacheRead: 0.03,
    timeoutMs: 30_000,
    verified: true,
  },
  'gemini-embedding-2': {
    id: 'gemini-embedding-2',
    provider: 'google',
    input: 0.2,
    output: 0,
    cacheRead: 0.2,
    timeoutMs: 30_000,
    verified: true,
  },
} as const satisfies Record<string, ModelSpec>;

export type ModelId = keyof typeof MODELS;

/** Claude's server-side web search: US$10 per 1,000 searches, on top of tokens (errored searches are free). */
export const WEB_SEARCH_USD_PER_REQUEST = 0.01;

/**
 * Server-side refusal fallbacks may answer from a model outside the catalog; meter those at the most
 * expensive current Claude tier so spend is never under-reported.
 */
export const UNKNOWN_MODEL_PRICE: Rates = { input: 10, output: 50, cacheRead: 1 };

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

/** The rates that applied to a call: base, then any effective-dated change, then the long-prompt tier. */
export function ratesFor(modelId: string, usage: TokenUsage, at: Date): Rates {
  const spec = modelSpec(modelId);
  if (!spec) return UNKNOWN_MODEL_PRICE;
  let rates: Rates = { input: spec.input, output: spec.output, cacheRead: spec.cacheRead };
  for (const change of spec.priceChanges ?? []) {
    if (at.getTime() >= Date.parse(change.from)) rates = { input: change.input, output: change.output, cacheRead: change.cacheRead };
  }
  const promptTokens = usage.inputTokens + usage.cacheReadTokens;
  if (spec.longPrompt && promptTokens > spec.longPrompt.aboveInputTokens) {
    const { input, output, cacheRead } = spec.longPrompt;
    rates = { input, output, cacheRead };
  }
  return rates;
}

/** US$ cost of one call made at `at`, rounded to the llm_calls column's 6 decimals. */
export function costUsd(modelId: string, usage: TokenUsage, at: Date): number {
  const rates = ratesFor(modelId, usage, at);
  const uncached = usage.inputTokens - usage.cacheWriteTokens;
  const dollars =
    (uncached * rates.input +
      usage.cacheWriteTokens * rates.input * 1.25 +
      usage.cacheReadTokens * rates.cacheRead +
      usage.outputTokens * rates.output) /
    1_000_000;
  return Math.round(dollars * 1_000_000) / 1_000_000;
}
