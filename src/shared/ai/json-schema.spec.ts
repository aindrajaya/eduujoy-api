import { z } from 'zod';
import { claudeRejectedKeys, toClaudeSchema, toStructuredSchema } from './json-schema';

const sample = z.object({
  steps: z.array(z.object({ n: z.number().int().min(1).max(50), score: z.number().min(0).max(1).describe('Confidence.') })).min(6).max(12),
  tags: z.array(z.string().min(1).max(20)).min(1).max(3),
  code: z.string().regex(/^r\d+$/),
  optional: z.number().int().max(9).nullable(),
});

describe('toClaudeSchema (Claude structured outputs reject numeric bounds and maxItems: 400, probed 2 Nov 2026)', () => {
  it('strips what Claude rejects and keeps what it accepts', () => {
    expect(claudeRejectedKeys(toStructuredSchema(sample)).length).toBeGreaterThan(0);
    const out = toClaudeSchema(sample);
    expect(claudeRejectedKeys(out)).toEqual([]);
    const json = JSON.stringify(out);
    // String bounds, patterns and minItems 0/1 are accepted, so they stay.
    expect(json).toContain('"minLength":1');
    expect(json).toContain('"maxLength":20');
    expect(json).toContain('"pattern"');
    expect(json).toContain('"minItems":1');
    expect(json).not.toMatch(/"maxItems"|"minimum"|"maximum"|"minItems":6/);
  });

  it('restates every stripped bound in the description, after any existing one', () => {
    const out = toClaudeSchema(sample) as { properties: Record<string, { description?: string; items?: { properties: Record<string, { description?: string }> } }> };
    expect(out.properties['steps']?.description).toBe('From 6 to 12 items.');
    expect(out.properties['steps']?.items?.properties['n']?.description).toBe('Integer from 1 to 50.');
    expect(out.properties['steps']?.items?.properties['score']?.description).toBe('Confidence. Number from 0 to 1.');
    expect(out.properties['tags']?.description).toBe('At most 3 items.');
    expect(JSON.stringify(out.properties['optional'])).toContain('Integer, at most 9.');
  });

  it('leaves the Zod schema itself unchanged, so the bounds are still enforced on the reply', () => {
    expect(sample.safeParse({ steps: [], tags: ['a'], code: 'r1', optional: null }).success).toBe(false);
  });
});
