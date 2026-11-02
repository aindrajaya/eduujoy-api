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

/** Keywords Claude's structured outputs reject (probed 2 Nov 2026: a 400 per keyword), by JSON type. */
export const CLAUDE_UNSUPPORTED: Record<string, readonly string[]> = {
  integer: ['minimum', 'maximum', 'exclusiveMinimum', 'exclusiveMaximum', 'multipleOf'],
  number: ['minimum', 'maximum', 'exclusiveMinimum', 'exclusiveMaximum', 'multipleOf'],
  array: ['maxItems'],
};

/** The stripped bounds as a sentence, so the model still sees them (lead gate, 2 Nov 2026). */
function boundsSentence(kind: string, dropped: Json): string {
  // Zod's .int() adds the safe-integer range on its own; that is no bound worth telling the model.
  const n = (key: string): number | undefined => {
    const value = dropped[key];
    return typeof value === 'number' && Math.abs(value) < Number.MAX_SAFE_INTEGER ? value : undefined;
  };
  if (kind === 'array') {
    const min = n('minItems');
    const max = n('maxItems');
    if (min !== undefined && max !== undefined) return `From ${min} to ${max} items.`;
    return max !== undefined ? `At most ${max} items.` : `At least ${min ?? 0} items.`;
  }
  const label = kind === 'integer' ? 'Integer' : 'Number';
  const parts: string[] = [];
  const min = n('minimum');
  const max = n('maximum');
  if (min !== undefined && max !== undefined) parts.push(`${label} from ${min} to ${max}.`);
  else if (min !== undefined) parts.push(`${label}, at least ${min}.`);
  else if (max !== undefined) parts.push(`${label}, at most ${max}.`);
  if (n('exclusiveMinimum') !== undefined) parts.push(`Greater than ${n('exclusiveMinimum')}.`);
  if (n('exclusiveMaximum') !== undefined) parts.push(`Less than ${n('exclusiveMaximum')}.`);
  if (n('multipleOf') !== undefined) parts.push(`A multiple of ${n('multipleOf')}.`);
  return parts.join(' ');
}

function forClaude(node: unknown): unknown {
  if (Array.isArray(node)) return node.map(forClaude);
  if (node === null || typeof node !== 'object') return node;
  const obj = node as Json;
  const types = (Array.isArray(obj['type']) ? (obj['type'] as unknown[]) : [obj['type']]).filter((t): t is string => typeof t === 'string');
  const drop = new Set(types.flatMap((t) => CLAUDE_UNSUPPORTED[t] ?? []));
  // Only "at least 0 or 1 items" is supported for arrays.
  if (types.includes('array') && typeof obj['minItems'] === 'number' && obj['minItems'] > 1) drop.add('minItems');
  const dropped = Object.fromEntries<unknown>(Object.entries(obj).filter(([key]) => drop.has(key)));
  const out = Object.fromEntries<unknown>(Object.entries(obj).filter(([key]) => !drop.has(key)).map(([key, value]) => [key, forClaude(value)]));
  if (Object.keys(dropped).length > 0 && boundsSentence(types.includes('array') ? 'array' : types.includes('integer') ? 'integer' : 'number', dropped)) {
    const kind = types.includes('array') ? 'array' : types.includes('integer') ? 'integer' : 'number';
    const sentence = boundsSentence(kind, dropped);
    out['description'] = typeof out['description'] === 'string' && out['description'] ? `${out['description']} ${sentence}` : sentence;
  }
  return out;
}

/** Every key in `schema` (at any depth) that Claude would reject; empty for a schema toClaudeSchema produced. */
export function claudeRejectedKeys(schema: unknown, path = '$'): string[] {
  if (Array.isArray(schema)) return schema.flatMap((s, i) => claudeRejectedKeys(s, `${path}[${i}]`));
  if (schema === null || typeof schema !== 'object') return [];
  const obj = schema as Json;
  const types = (Array.isArray(obj['type']) ? (obj['type'] as unknown[]) : [obj['type']]).filter((t): t is string => typeof t === 'string');
  const own = Object.keys(obj).filter(
    (key) => types.some((t) => CLAUDE_UNSUPPORTED[t]?.includes(key)) || (key === 'minItems' && types.includes('array') && typeof obj[key] === 'number' && obj[key] > 1),
  );
  return [...own.map((key) => `${path}.${key}`), ...Object.entries(obj).flatMap(([key, value]) => claudeRejectedKeys(value, `${path}.${key}`))];
}

/**
 * The structured-output schema for Claude: toStructuredSchema without the keywords Claude rejects with a
 * 400 (numeric bounds, maxItems, minItems above 1), each restated in the property's description. The
 * full Zod schema still parses every reply, so the bounds are enforced client-side, as the official
 * SDK's parse helper does; a reply that breaks one is a metered invalid_output (never retried in the
 * call, PRD-API §11).
 */
export function toClaudeSchema(schema: ZodType): Json {
  return forClaude(toStructuredSchema(schema)) as Json;
}
