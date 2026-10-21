import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { z } from 'zod';

// Seed format v1 (see docs/seed-format.md). The credit-sprint tooling writes it; this loader
// validates strictly so format drift fails loudly instead of loading half a taxonomy.

const slug = z.string().regex(/^[a-z0-9]+(-[a-z0-9]+)*$/, { error: 'must be kebab-case' }).max(80);
const stage = z.enum(['novice', 'advanced_beginner', 'competent', 'proficient', 'expert']);
const bloom = z.enum(['C1', 'C2', 'C3', 'C4', 'C5', 'C6']);

const topicSchema = z.strictObject({
  slug,
  canonicalName: z.string().min(1).max(120),
  aliases: z.array(z.string().min(1).max(120)).max(30),
  description: z.string().min(1).max(500),
  domain: z.enum(['software', 'stem', 'non_technical']),
  parent: slug.nullable(),
  prerequisites: z.array(slug).max(20),
});

const optionSchema = z.strictObject({ id: z.string().min(1).max(20), label: z.string().min(1).max(500) });

const itemSchema = z
  .strictObject({
    key: z.string().regex(/^[a-z0-9_-]{1,40}$/),
    stage,
    bloom,
    kind: z.enum(['single_choice', 'multi_choice', 'short_answer', 'scenario']),
    prompt: z.string().min(1).max(4000),
    options: z.array(optionSchema).min(2).max(8).optional(),
    answerKey: z
      .strictObject({
        optionIds: z.array(z.string()).min(1).optional(),
        text: z.string().max(4000).optional(),
      })
      .optional(),
    rubric: z.array(z.string().min(1).max(500)).max(10).optional(),
    reviewed: z.boolean().default(false),
  })
  .superRefine((item, ctx) => {
    const choice = item.kind === 'single_choice' || item.kind === 'multi_choice';
    if (choice && !item.options) ctx.addIssue({ code: 'custom', path: ['options'], message: 'required for choice items' });
    if (!choice && item.options) ctx.addIssue({ code: 'custom', path: ['options'], message: 'only for choice items' });
    const keyed = item.answerKey?.optionIds ?? [];
    const ids = new Set(item.options?.map((option) => option.id));
    if (keyed.some((id) => !ids.has(id))) {
      ctx.addIssue({ code: 'custom', path: ['answerKey', 'optionIds'], message: 'must reference option ids' });
    }
    if (item.kind === 'single_choice' && keyed.length !== 1) {
      ctx.addIssue({ code: 'custom', path: ['answerKey', 'optionIds'], message: 'single_choice needs exactly one' });
    }
  });

const topicsFileSchema = z.strictObject({ version: z.literal(1), topics: z.array(topicSchema).min(1).max(1000) });
const itemsFileSchema = z.strictObject({ version: z.literal(1), topic: slug, items: z.array(itemSchema).min(1).max(500) });

export type SeedTopic = z.infer<typeof topicSchema>;
export type SeedItem = z.infer<typeof itemSchema> & { topic: string; seedKey: string };
export interface SeedData {
  topics: SeedTopic[];
  items: SeedItem[];
}
/** Raw JSON: `topics` from topics.json, `items` keyed by items/<stem>.json. */
export interface SeedFiles {
  topics: unknown;
  items: Record<string, unknown>;
}

export class SeedValidationError extends Error {
  override name = 'SeedValidationError';
  constructor(readonly problems: string[]) {
    super(`Seed data is invalid:\n- ${problems.join('\n- ')}`);
  }
}

export function readSeedFiles(dir: string): SeedFiles {
  const readJson = (path: string): unknown => JSON.parse(readFileSync(path, 'utf8'));
  const itemsDir = join(dir, 'items');
  const items: Record<string, unknown> = {};
  if (existsSync(itemsDir)) {
    for (const file of readdirSync(itemsDir).filter((name) => name.endsWith('.json')).sort()) {
      items[basename(file, '.json')] = readJson(join(itemsDir, file));
    }
  }
  return { topics: readJson(join(dir, 'topics.json')), items };
}

export function parseSeed(files: SeedFiles): SeedData {
  const problems: string[] = [];
  const report = (file: string, error: z.ZodError): void => {
    for (const issue of error.issues) problems.push(`${file} ${issue.path.join('.')}: ${issue.message}`);
  };

  const topicsResult = topicsFileSchema.safeParse(files.topics);
  if (!topicsResult.success) report('topics.json', topicsResult.error);
  const topics = topicsResult.success ? topicsResult.data.topics : [];

  const slugs = new Set<string>();
  for (const t of topics) {
    if (slugs.has(t.slug)) problems.push(`topics.json: duplicate slug "${t.slug}"`);
    slugs.add(t.slug);
  }
  for (const t of topics) {
    if (t.parent !== null && !slugs.has(t.parent)) problems.push(`topics.json ${t.slug}: unknown parent "${t.parent}"`);
    for (const p of t.prerequisites) {
      if (!slugs.has(p)) problems.push(`topics.json ${t.slug}: unknown prerequisite "${p}"`);
    }
  }
  const cycle = findCycle(topics);
  if (cycle) problems.push(`topics.json: prerequisite cycle: ${cycle.join(' -> ')}`);

  const items: SeedItem[] = [];
  for (const [stem, raw] of Object.entries(files.items)) {
    const file = `items/${stem}.json`;
    const result = itemsFileSchema.safeParse(raw);
    if (!result.success) {
      report(file, result.error);
      continue;
    }
    const { topic, items: fileItems } = result.data;
    if (topic !== stem) problems.push(`${file} declares topic "${topic}"; name the file items/${topic}.json`);
    if (topicsResult.success && !slugs.has(topic)) problems.push(`${file}: unknown topic "${topic}"`);
    const keys = new Set<string>();
    for (const item of fileItems) {
      if (keys.has(item.key)) problems.push(`${file}: duplicate item key "${item.key}"`);
      keys.add(item.key);
      items.push({ ...item, topic, seedKey: `${topic}:${item.key}` });
    }
  }

  if (problems.length > 0) throw new SeedValidationError(problems);
  return { topics, items };
}

/** Depth-first search over prerequisite edges; returns the first cycle as a closed walk. */
function findCycle(topics: SeedTopic[]): string[] | undefined {
  const edges = new Map(topics.map((t) => [t.slug, t.prerequisites]));
  const state = new Map<string, 'visiting' | 'done'>();
  const stack: string[] = [];

  const visit = (node: string): string[] | undefined => {
    if (state.get(node) === 'done') return undefined;
    if (state.get(node) === 'visiting') return [...stack.slice(stack.indexOf(node)), node];
    state.set(node, 'visiting');
    stack.push(node);
    for (const next of edges.get(node) ?? []) {
      const found = visit(next);
      if (found) return found;
    }
    stack.pop();
    state.set(node, 'done');
    return undefined;
  };

  for (const t of topics) {
    const found = visit(t.slug);
    if (found) return found;
  }
  return undefined;
}
