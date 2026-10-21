import { z, type ZodType } from 'zod';

type Json = Record<string, unknown>;

function close(node: unknown): unknown {
  if (Array.isArray(node)) return node.map(close);
  if (node === null || typeof node !== 'object') return node;
  const out: Json = {};
  for (const [key, value] of Object.entries(node)) {
    if (key === '$schema') continue;
    out[key] = close(value);
  }
  if (out['type'] === 'object' && !('additionalProperties' in out)) out['additionalProperties'] = false;
  return out;
}

/**
 * JSON Schema for provider structured-output modes, generated from the same Zod schema that parses
 * the reply. Objects are closed (additionalProperties: false), as strict structured outputs require.
 */
export function toStructuredSchema(schema: ZodType): Json {
  return close(z.toJSONSchema(schema, { io: 'output' })) as Json;
}
