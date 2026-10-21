import { costUsd, MODELS } from './catalog';

const usage = (over: Partial<Parameters<typeof costUsd>[1]> = {}) => ({
  inputTokens: 0,
  cacheWriteTokens: 0,
  cacheReadTokens: 0,
  outputTokens: 0,
  ...over,
});
const NOW = new Date('2026-10-21T10:00:00Z');

describe('costUsd', () => {
  it('prices Sonnet 5.5 input, output and cache reads per 1M tokens', () => {
    expect(costUsd('claude-sonnet-5-5', usage({ inputTokens: 1_000_000 }), NOW)).toBe(2);
    expect(costUsd('claude-sonnet-5-5', usage({ outputTokens: 1_000_000 }), NOW)).toBe(10);
    expect(costUsd('claude-sonnet-5-5', usage({ cacheReadTokens: 1_000_000 }), NOW)).toBe(0.1);
  });

  it('bills cache writes at 1.25x the input rate', () => {
    expect(costUsd('claude-sonnet-5-5', usage({ inputTokens: 1_000_000, cacheWriteTokens: 1_000_000 }), NOW)).toBe(2.5);
  });

  it('keeps Haiku 5.5 on base rates at exactly 100k prompt tokens', () => {
    // 90k uncached x $0.10 + 10k cache reads x $0.01 + 1k output x $0.50
    expect(costUsd('claude-haiku-5-5', usage({ inputTokens: 90_000, cacheReadTokens: 10_000, outputTokens: 1_000 }), NOW)).toBe(
      0.0096,
    );
  });

  it('moves Haiku 5.5 to the long-prompt tier above 100k, cache reads included', () => {
    // 90_001 uncached x $0.50 + 10_000 cache reads x $0.05 + 1_000 output x $2.50 = $0.0480005
    expect(costUsd('claude-haiku-5-5', usage({ inputTokens: 90_001, cacheReadTokens: 10_000, outputTokens: 1_000 }), NOW)).toBe(
      0.048001,
    );
  });

  it('switches Gemini 3.8 Flash to the 2027 prices at 2027-01-01T00:00:00Z', () => {
    const tokens = usage({ inputTokens: 1_000_000, cacheReadTokens: 1_000_000, outputTokens: 1_000_000 });

    expect(costUsd('gemini-3.8-flash', tokens, new Date('2026-12-31T23:59:59.999Z'))).toBe(0.75 + 0.075 + 3.75);
    expect(costUsd('gemini-3.8-flash', tokens, new Date('2027-01-01T00:00:00Z'))).toBe(1.5 + 0.15 + 7.5);
  });

  it('prices Flash-Lite cache reads and embeddings', () => {
    expect(costUsd('gemini-3.5-flash-lite', usage({ cacheReadTokens: 1_000_000 }), NOW)).toBe(0.03);
    expect(costUsd('gemini-embedding-2', usage({ inputTokens: 1_000_000 }), NOW)).toBe(0.2);
  });

  it('meters an unknown fallback model at the most expensive tier', () => {
    expect(costUsd('claude-someday-9', usage({ inputTokens: 1_000_000 }), NOW)).toBe(10);
  });

  it('rounds to 6 decimals', () => {
    expect(costUsd('gemini-3.5-flash-lite', usage({ inputTokens: 7 }), NOW)).toBe(0.000002);
  });

  it('lists only the PRD models, all verified', () => {
    expect(Object.keys(MODELS).sort()).toEqual([
      'claude-haiku-5-5',
      'claude-sonnet-5-5',
      'gemini-3.5-flash-lite',
      'gemini-3.8-flash',
      'gemini-embedding-2',
    ]);
    expect(Object.values(MODELS).map((m) => m.verified)).not.toContain(false);
  });
});
