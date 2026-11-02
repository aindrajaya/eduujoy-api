import { type ZodType } from 'zod';
import { judgeSchema } from '../../scripts/eval/path-eval-rules';
import { NORMALISED_TOPIC_SCHEMA } from '../../src/modules/catalog/infrastructure/haiku-topic-normalizer';
import { designSchema } from '../../src/modules/pathing/infrastructure/claude-path-designer';
import { claudeRejectedKeys, toClaudeSchema, toStructuredSchema } from '../../src/shared/ai/json-schema';

/**
 * Every schema the API sends to Claude as a structured output (ClaudeStructuredGenerator). Add each new
 * one here: the test proves none of the keywords Claude rejects with a 400 survives (2 Nov 2026).
 * Not here: web discovery (Claude web search answers in text, parsed with Zod, no output schema), and
 * tools/seed (credit sprint; builds its own output_config from function-local schemas).
 */
const CLAUDE_SCHEMAS: Record<string, ZodType> = {
  'catalog topic-normalise (Haiku)': NORMALISED_TOPIC_SCHEMA,
  'pathing path-designer (Sonnet)': designSchema,
  'eval path-judge (Sonnet)': judgeSchema,
};

describe('schemas sent to Claude', () => {
  it.each(Object.entries(CLAUDE_SCHEMAS))('%s carries no keyword Claude rejects', (_name, schema) => {
    expect(claudeRejectedKeys(toClaudeSchema(schema))).toEqual([]);
  });

  it('records what the fix strips from each (the before list for the inventory)', () => {
    const before = Object.fromEntries(Object.entries(CLAUDE_SCHEMAS).map(([name, schema]) => [name, claudeRejectedKeys(toStructuredSchema(schema))]));
    expect(before['catalog topic-normalise (Haiku)']).toEqual(['$.properties.aliases.maxItems']);
    expect(before['pathing path-designer (Sonnet)']).toHaveLength(17);
    expect(before['eval path-judge (Sonnet)']).toHaveLength(10);
  });

  it('still enforces the stripped bounds on the reply (Zod)', () => {
    const tooMany = { canonicalName: 'X', domain: 'software', description: 'Y', aliases: Array.from({ length: 11 }, (_, i) => `a${i}`) };
    expect(NORMALISED_TOPIC_SCHEMA.safeParse(tooMany).success).toBe(false);
    expect(NORMALISED_TOPIC_SCHEMA.safeParse({ ...tooMany, aliases: tooMany.aliases.slice(0, 10) }).success).toBe(true);
  });
});
