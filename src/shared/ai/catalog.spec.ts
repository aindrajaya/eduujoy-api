import { costUsd, MODELS } from './catalog';

const usage = (over: Partial<Parameters<typeof costUsd>[1]> = {}) => ({
  inputTokens: 0,
  cacheWriteTokens: 0,
  cacheReadTokens: 0,
  outputTokens: 0,
  ...over,
});

describe('costUsd', () => {
  it('prices Sonnet 5.5 input, output and cache reads per 1M tokens', () => {
    expect(costUsd('claude-sonnet-5-5', usage({ inputTokens: 1_000_000 }))).toBe(2);
    expect(costUsd('claude-sonnet-5-5', usage({ outputTokens: 1_000_000 }))).toBe(10);
    expect(costUsd('claude-sonnet-5-5', usage({ cacheReadTokens: 1_000_000 }))).toBe(0.2);
  });

  it('bills cache writes at 1.25x the input rate', () => {
    expect(costUsd('claude-sonnet-5-5', usage({ inputTokens: 1_000_000, cacheWriteTokens: 1_000_000 }))).toBe(2.5);
  });

  it('switches Haiku 5.5 to the long-prompt tier above 100k prompt tokens', () => {
    expect(costUsd('claude-haiku-5-5', usage({ inputTokens: 100_000, outputTokens: 1_000 }))).toBeCloseTo(0.0105, 6);
    // (100_001 x $0.50 + 1_000 x $2.50) / 1M = 0.0525005, rounded to 6 decimals.
    expect(costUsd('claude-haiku-5-5', usage({ inputTokens: 100_001, outputTokens: 1_000 }))).toBe(0.052501);
  });

  it('meters an unknown fallback model at the most expensive tier', () => {
    expect(costUsd('claude-someday-9', usage({ inputTokens: 1_000_000 }))).toBe(10);
  });

  it('rounds to 6 decimals', () => {
    expect(costUsd('gemini-3.5-flash-lite', usage({ inputTokens: 7 }))).toBe(0.000002);
  });

  it('only lists the models the PRD assigns', () => {
    expect(Object.keys(MODELS).sort()).toEqual([
      'claude-haiku-5-5',
      'claude-sonnet-5-5',
      'gemini-3.5-flash-lite',
      'gemini-3.8-flash',
      'gemini-embedding-2',
    ]);
  });
});
