import { MODELS } from '../../src/shared/ai/catalog';

// Credit-sprint pricing (PRD-API §11). List prices come from the app's catalog so the tool and the
// metering code agree; the Batch API bills every token class at half price.

export const SEED_MODEL = 'claude-sonnet-5-5' as const;
export const SPEND_CAP_USD = 90;

const BATCH_DISCOUNT = 0.5;
const CACHE_WRITE_MULTIPLIER = 1.25;

export interface Usage {
  input: number;
  cacheWrite: number;
  cacheRead: number;
  output: number;
}

export const ZERO_USAGE: Usage = { input: 0, cacheWrite: 0, cacheRead: 0, output: 0 };

export function addUsage(a: Usage, b: Usage): Usage {
  return { input: a.input + b.input, cacheWrite: a.cacheWrite + b.cacheWrite, cacheRead: a.cacheRead + b.cacheRead, output: a.output + b.output };
}

export function fromApiUsage(usage: {
  input_tokens: number;
  output_tokens: number;
  cache_creation_input_tokens?: number | null;
  cache_read_input_tokens?: number | null;
}): Usage {
  return {
    input: usage.input_tokens,
    cacheWrite: usage.cache_creation_input_tokens ?? 0,
    cacheRead: usage.cache_read_input_tokens ?? 0,
    output: usage.output_tokens,
  };
}

export function costUsd(usage: Usage, batch: boolean): number {
  const rates = MODELS[SEED_MODEL];
  const usd =
    (usage.input * rates.input +
      usage.cacheWrite * rates.input * CACHE_WRITE_MULTIPLIER +
      usage.cacheRead * rates.cacheRead +
      usage.output * rates.output) /
    1_000_000;
  return batch ? usd * BATCH_DISCOUNT : usd;
}

/** Offline token estimate: ~3 characters per token, on the high side for English prose and JSON. */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 3);
}

export interface RequestShape {
  /** Shared prefix marked for caching (system prompt and catalog). */
  prefixTokens: number;
  /** Per-request suffix (the user turn). */
  suffixTokens: number;
  /** Expected output per request, thinking included. */
  outputTokens: number;
}

export interface Estimate {
  requests: number;
  inputTokens: number;
  outputTokens: number;
  /** Every request pays the full prefix: the gate figure. */
  usdNoCache: number;
  /** One cache write, every later request reads it. Batch caching is best effort, so this is a floor. */
  usdCached: number;
}

export function estimate(requests: number, shape: RequestShape, batch: boolean): Estimate {
  const inputTokens = requests * (shape.prefixTokens + shape.suffixTokens);
  const outputTokens = requests * shape.outputTokens;
  const usdNoCache = costUsd({ ...ZERO_USAGE, input: inputTokens, output: outputTokens }, batch);
  const usdCached =
    requests === 0
      ? 0
      : costUsd(
          {
            input: requests * shape.suffixTokens,
            cacheWrite: shape.prefixTokens,
            cacheRead: (requests - 1) * shape.prefixTokens,
            output: outputTokens,
          },
          batch,
        );
  return { requests, inputTokens, outputTokens, usdNoCache, usdCached };
}

export function formatEstimate(label: string, e: Estimate, batch: boolean): string {
  const mode = batch ? 'Batch API (50% off)' : 'Messages API (standard price)';
  return [
    `${label}: ${SEED_MODEL}, ${mode}`,
    `  requests:      ${e.requests}`,
    `  input tokens:  ~${e.inputTokens.toLocaleString('en-US')}`,
    `  output tokens: ~${e.outputTokens.toLocaleString('en-US')} (thinking included)`,
    `  US$ estimate:  ${usd(e.usdNoCache)} without cache hits, ${usd(e.usdCached)} with full cache hits`,
  ].join('\n');
}

export function usd(value: number): string {
  return `$${value.toFixed(value < 1 ? 3 : 2)}`;
}
