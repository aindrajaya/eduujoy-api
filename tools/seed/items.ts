import { existsSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import Anthropic from '@anthropic-ai/sdk';
import { z } from 'zod';
import { toStructuredSchema } from '../../src/shared/ai/json-schema';
import { PromptRegistry } from '../../src/shared/ai/prompts/prompt-registry';
import { parseSeed, readSeedFiles, type SeedTopic } from '../../src/shared/db/seed/seed-data';
import { collectBatch, replyJson, submitBatch } from './batch';
import { assertWithinCap, logSpend, openRun, reject, ROOT, SEED_DIR, writeJson } from './ledger';
import { addUsage, estimate, estimateTokens, formatEstimate, fromApiUsage, SEED_MODEL, usd, ZERO_USAGE, type Usage } from './pricing';
import { spread } from './sample';

// seed:items. Diagnostic item banks (PRD-API §11, master FR-03) for the topics in seed/topics.json, in
// seed format v1 (docs/seed-format.md). One request per topic and Dreyfus stage writes 14 items: 7 per
// Bloom cell of the stage's band (5 single choice, 1 multi choice, 1 multiple-choice scenario), so each
// topic gets 70 auto-gradable items across the 10 cells of the A7 diagnostic ladder. Finished stages wait
// in seed/_work/items/<slug>.json; seed/items/<slug>.json is written once all five stages pass.

const COMMAND = 'items';
const ITEMS_DIR = join(SEED_DIR, 'items');
const WORK_DIR = join(SEED_DIR, '_work', 'items');
const PROMPT = new PromptRegistry(join(ROOT, 'src', 'prompts')).get('diagnostic-items', 'v2');

const MAX_TOKENS = 32_000; // 5 of 740 v2 replies hit 16,000
const EXPECTED_OUTPUT_TOKENS = 7_000; // prompt v2 sample: 6,872 per request

export const STAGES = [
  { stage: 'novice', abbr: 'nov', band: ['C1', 'C2'] },
  { stage: 'advanced_beginner', abbr: 'adb', band: ['C2', 'C3'] },
  { stage: 'competent', abbr: 'cmp', band: ['C3', 'C4'] },
  { stage: 'proficient', abbr: 'prf', band: ['C4', 'C5'] },
  { stage: 'expert', abbr: 'exp', band: ['C5', 'C6'] },
] as const;
export type StageSpec = (typeof STAGES)[number];

const KINDS = ['single_choice', 'multi_choice', 'scenario'] as const;
type Kind = (typeof KINDS)[number];
/** Items per Bloom cell, by kind. */
const PER_CELL: Record<Kind, number> = { single_choice: 5, multi_choice: 1, scenario: 1 };
const KIND_ABBR: Record<Kind, string> = { single_choice: 'sc', multi_choice: 'mc', scenario: 'sn' };
const ITEMS_PER_STAGE = 2 * Object.values(PER_CELL).reduce((a, b) => a + b, 0);
const OPTION_IDS = ['a', 'b', 'c', 'd', 'e'];

const generatedItem = z
  .object({
    bloom: z.enum(['C1', 'C2', 'C3', 'C4', 'C5', 'C6']),
    kind: z.enum(KINDS),
    prompt: z.string().trim().min(10).max(1200),
    options: z.array(z.string().trim().min(1).max(300)).min(4).max(5),
    correct: z.array(z.number().int().min(0)).min(1).max(3),
    rubric: z.array(z.string().trim().min(1).max(400)).min(1).max(3),
  })
  .superRefine((item, ctx) => {
    const fail = (message: string): void => {
      ctx.addIssue({ code: 'custom', message });
    };
    const single = item.kind !== 'multi_choice';
    if (single && item.options.length !== 4) fail(`${item.kind} needs 4 options`);
    if (single && item.correct.length !== 1) fail(`${item.kind} needs exactly 1 correct option`);
    if (!single && (item.correct.length < 2 || item.correct.length > 3)) fail('multi_choice needs 2 or 3 correct options');
    if (new Set(item.correct).size !== item.correct.length) fail('correct has duplicates');
    if (item.correct.some((i) => i >= item.options.length)) fail('correct points past the options');
    // Case matters: `F(b) - F(a)` and `f(b) - f(a)` are different answers.
    if (new Set(item.options.map((o) => o.replace(/\s+/g, ' '))).size !== item.options.length) fail('duplicate options');
  });
type GeneratedItem = z.infer<typeof generatedItem>;

const replyShape = z.object({ items: z.array(z.unknown()) });

export type Selection = { items: GeneratedItem[]; dropped: string[] } | { short: string[]; dropped: string[] };

/**
 * Picks one stage's items from a reply. Each item is checked on its own; invalid items, items outside
 * the stage's band and surplus items are dropped, and the first valid items per Bloom cell and kind are
 * kept (PER_CELL). Only a cell that can't be filled fails the reply.
 */
export function selectItems(spec: StageSpec, reply: unknown): Selection {
  const parsed = replyShape.safeParse(reply);
  if (!parsed.success) return { short: ['reply has no items array'], dropped: [] };
  const band: readonly string[] = spec.band;
  const kept: GeneratedItem[] = [];
  const dropped: string[] = [];
  parsed.data.items.forEach((raw, index) => {
    const item = generatedItem.safeParse(raw);
    if (!item.success) {
      dropped.push(`#${index} invalid: ${item.error.issues.map((i) => i.message).join(', ')}`);
    } else if (!band.includes(item.data.bloom)) {
      dropped.push(`#${index} ${item.data.bloom} is outside ${band.join('/')}`);
    } else if (kept.filter((k) => k.bloom === item.data.bloom && k.kind === item.data.kind).length >= PER_CELL[item.data.kind]) {
      dropped.push(`#${index} surplus ${item.data.bloom} ${item.data.kind}`);
    } else {
      kept.push(item.data);
    }
  });
  const short = spec.band.flatMap((bloom) =>
    KINDS.flatMap((kind) => {
      const n = kept.filter((k) => k.bloom === bloom && k.kind === kind).length;
      return n < PER_CELL[kind] ? [`${bloom} ${kind}: ${n} of ${PER_CELL[kind]}`] : [];
    }),
  );
  return short.length > 0 ? { short, dropped } : { items: kept, dropped };
}

/** Single-answer items (single choice and scenario) whose key is the one longest option. */
export function longestKeyCount(items: GeneratedItem[]): { longest: number; total: number } {
  const single = items.filter((i) => i.kind !== 'multi_choice');
  const longest = single.filter((i) => {
    const lengths = i.options.map((o) => o.length);
    const max = Math.max(...lengths);
    const key = i.correct[0] ?? -1;
    return lengths[key] === max && lengths.filter((l) => l === max).length === 1;
  }).length;
  return { longest, total: single.length };
}

/** Longest-key tally for the items accepted in this run, by stage. */
const runStats = new Map<string, { longest: number; total: number }>();

function printRunStats(): void {
  const rows = STAGES.flatMap((spec) => {
    const s = runStats.get(spec.stage);
    return s ? [[spec.stage, s] as const] : [];
  });
  if (rows.length === 0) return;
  const pct = (s: { longest: number; total: number }): string => `${s.longest}/${s.total} (${Math.round((100 * s.longest) / s.total)}%)`;
  const all = rows.reduce((a, [, s]) => ({ longest: a.longest + s.longest, total: a.total + s.total }), { longest: 0, total: 0 });
  process.stdout.write(`Key is the longest option in single-answer items: ${pct(all)}; chance is 25%, target at most 30%.\n`);
  for (const [stage, s] of rows) process.stdout.write(`  ${stage.padEnd(18)} ${pct(s)}\n`);
}

const workSchema = z.object({ promptVersion: z.string(), stages: z.record(z.string(), z.array(generatedItem)) });
type Work = z.infer<typeof workSchema>;

interface Unit {
  id: string;
  topic: SeedTopic;
  spec: StageSpec;
}

export interface ItemsOptions {
  dryRun: boolean;
  go: boolean;
  sample?: number;
}

function loadTopics(): SeedTopic[] {
  return parseSeed({ topics: readSeedFiles(SEED_DIR).topics, items: {} }).topics;
}

function workPath(slug: string): string {
  return join(WORK_DIR, `${slug}.json`);
}

function loadWork(slug: string): Work {
  const path = workPath(slug);
  if (!existsSync(path)) return { promptVersion: PROMPT.version, stages: {} };
  const work = workSchema.parse(JSON.parse(readFileSync(path, 'utf8')));
  return work.promptVersion === PROMPT.version ? work : { promptVersion: PROMPT.version, stages: {} };
}

/** Units still to generate: topics without an items file, stages not yet in their work file. */
function pendingUnits(topics: SeedTopic[]): Unit[] {
  const units: Unit[] = [];
  for (const topic of topics) {
    if (existsSync(join(ITEMS_DIR, `${topic.slug}.json`))) continue;
    const done = loadWork(topic.slug).stages;
    for (const spec of STAGES) if (!done[spec.stage]) units.push({ id: `${topic.slug}--${spec.abbr}`, topic, spec });
  }
  return units;
}

function topicBlock(topics: SeedTopic[], topic: SeedTopic, spec: StageSpec): string {
  const name = (slug: string): string => topics.find((t) => t.slug === slug)?.canonicalName ?? slug;
  const lines = [
    `Name: ${topic.canonicalName}`,
    `Domain: ${topic.domain}`,
    `Description: ${topic.description}`,
    `Also called: ${topic.aliases.join(', ') || 'none'}`,
    `Part of: ${topic.parent ? name(topic.parent) : 'none'}`,
    `Prerequisites (assume known): ${topic.prerequisites.map(name).join(', ') || 'none'}`,
  ];
  return `<topic>\n${lines.join('\n')}\n</topic>\nStage: ${spec.stage} (Bloom ${spec.band.join(' and ')})`;
}

function requestParams(topics: SeedTopic[], unit: Unit): Anthropic.MessageCreateParamsNonStreaming {
  // Bounds stay out of the API schema (structured outputs reject most of them); selectItems enforces them.
  const apiSchema = z.object({
    items: z.array(
      z.object({
        bloom: z.enum(unit.spec.band),
        kind: z.enum(KINDS),
        prompt: z.string(),
        options: z.array(z.string()),
        correct: z.array(z.number()),
        rubric: z.array(z.string()),
      }),
    ),
  });
  return {
    model: SEED_MODEL,
    max_tokens: MAX_TOKENS,
    system: [{ type: 'text', text: PROMPT.text, cache_control: { type: 'ephemeral' } }],
    messages: [{ role: 'user', content: topicBlock(topics, unit.topic, unit.spec) }],
    output_config: { format: { type: 'json_schema', schema: toStructuredSchema(apiSchema) }, effort: 'medium' },
  };
}

/** Selects one stage's items and stores them in the topic's work file; false (with a reject row) otherwise. */
function acceptReply(unit: Unit, message: Anthropic.Message): boolean {
  const json = replyJson(COMMAND, unit.id, message);
  if (json === undefined) return false;
  const selection = selectItems(unit.spec, json);
  if ('short' in selection) {
    reject(COMMAND, unit.id, `cells short: ${selection.short.join('; ')}; dropped: ${selection.dropped.join('; ') || 'none'}`, json);
    return false;
  }
  if (selection.dropped.length > 0) reject(COMMAND, unit.id, `accepted after dropping: ${selection.dropped.join('; ')}`);
  const stats = runStats.get(unit.spec.stage) ?? { longest: 0, total: 0 };
  const count = longestKeyCount(selection.items);
  runStats.set(unit.spec.stage, { longest: stats.longest + count.longest, total: stats.total + count.total });
  const work = loadWork(unit.topic.slug);
  work.stages[unit.spec.stage] = selection.items;
  writeJson(workPath(unit.topic.slug), work);
  return true;
}

function estimateFor(topics: SeedTopic[], units: Unit[], batch: boolean): ReturnType<typeof estimate> {
  const prefixTokens = estimateTokens(PROMPT.text) + 400; // + output schema
  const suffixTokens = Math.max(...units.map((u) => estimateTokens(topicBlock(topics, u.topic, u.spec))));
  return estimate(units.length, { prefixTokens, suffixTokens, outputTokens: EXPECTED_OUTPUT_TOKENS }, batch);
}

export async function runItems(options: ItemsOptions): Promise<void> {
  const topics = loadTopics();
  const write = (line: string): boolean => process.stdout.write(`${line}\n`);
  const units = new Map(topics.flatMap((topic) => STAGES.map((spec): [string, Unit] => [`${topic.slug}--${spec.abbr}`, { id: `${topic.slug}--${spec.abbr}`, topic, spec }])));

  const open = openRun(COMMAND);
  if (open) {
    if (options.dryRun) {
      write(`Batch ${open.batchId} (${open.requests} requests) is still open; a real run collects it at no extra cost.`);
      return;
    }
    await collect(new Anthropic(), units, open.batchId);
    printRunStats();
    assemble(topics);
    return;
  }

  const pending = pendingUnits(topics);
  const doneTopics = topics.filter((t) => existsSync(join(ITEMS_DIR, `${t.slug}.json`))).length;
  write(`Items: ${topics.length} topics, ${doneTopics} with an item bank; ${pending.length} of ${topics.length * STAGES.length} topic-stage requests pending (prompt ${PROMPT.name}/${PROMPT.version}).`);
  if (pending.length === 0) return;

  const sampleTopics = options.sample === undefined ? undefined : new Set(spread([...new Map(pending.map((u) => [u.topic.slug, u.topic])).values()], options.sample).map((t) => t.slug));
  const targets = sampleTopics ? pending.filter((u) => sampleTopics.has(u.topic.slug)) : pending;
  const batch = sampleTopics === undefined;
  const est = estimateFor(topics, targets, batch);
  const items = targets.length * ITEMS_PER_STAGE;
  write(formatEstimate(sampleTopics ? `seed:items --sample ${sampleTopics.size} (${[...sampleTopics].join(', ')})` : 'seed:items', est, batch));
  write(`  items:         ${items.toLocaleString('en-US')} (${ITEMS_PER_STAGE} per topic-stage request)`);
  if (options.dryRun) return;
  if (!options.go) {
    write('Not started: rerun with --go once the estimate is approved.');
    return;
  }
  assertWithinCap(est.usdNoCache);

  const client = new Anthropic();
  if (!batch) {
    await runSample(client, topics, targets);
    printRunStats();
    assemble(topics);
    return;
  }
  const requests = targets.map((unit) => ({ custom_id: unit.id, params: requestParams(topics, unit) }));
  await collect(client, units, await submitBatch(client, COMMAND, PROMPT.version, requests));
  printRunStats();
  assemble(topics);
}

async function runSample(client: Anthropic, topics: SeedTopic[], targets: Unit[]): Promise<void> {
  let usage: Usage = ZERO_USAGE;
  let accepted = 0;
  try {
    for (const unit of targets) {
      const message = await client.messages.create(requestParams(topics, unit), { timeout: 180_000, maxRetries: 2 });
      usage = addUsage(usage, fromApiUsage(message.usage));
      if (acceptReply(unit, message)) accepted++;
    }
  } finally {
    const cost = logSpend({ command: `${COMMAND} --sample`, batch: false, requests: targets.length, usage, ref: PROMPT.version });
    process.stdout.write(`Sample done: ${accepted}/${targets.length} topic-stage replies accepted, actual cost ${usd(cost)}.\n`);
  }
}

async function collect(client: Anthropic, units: Map<string, Unit>, batchId: string): Promise<void> {
  await collectBatch(client, COMMAND, batchId, (id, message) => {
    const unit = units.get(id);
    if (!unit) {
      reject(COMMAND, id, 'unknown custom_id');
      return false;
    }
    return acceptReply(unit, message);
  });
}

/** Writes seed/items/<slug>.json for every topic whose five stages are all in its work file. */
function assemble(topics: SeedTopic[]): void {
  let written = 0;
  for (const topic of topics) {
    const target = join(ITEMS_DIR, `${topic.slug}.json`);
    if (existsSync(target)) continue;
    const work = loadWork(topic.slug);
    if (!STAGES.every((spec) => work.stages[spec.stage])) continue;
    const file = { version: 1, topic: topic.slug, items: STAGES.flatMap((spec) => toSeedItems(topic.slug, spec, work.stages[spec.stage] ?? [])) };
    try {
      parseSeed({ topics: { version: 1, topics }, items: { [topic.slug]: file } });
    } catch (error) {
      reject(COMMAND, topic.slug, `assembled file fails the seed parser: ${error instanceof Error ? error.message : String(error)}`);
      continue;
    }
    writeJson(target, file);
    rmSync(workPath(topic.slug));
    written++;
  }
  const missing = topics.filter((t) => !existsSync(join(ITEMS_DIR, `${t.slug}.json`))).length;
  process.stdout.write(`Wrote ${written} item files; ${missing} topics still need items${missing > 0 ? ' (rerun to retry them)' : ''}.\n`);
}

/** Seed-format items with stable keys (nov-c1-sc1) and options shuffled deterministically per key. */
export function toSeedItems(slug: string, spec: StageSpec, generated: GeneratedItem[]): object[] {
  const counters = new Map<string, number>();
  return generated.map((item) => {
    const cell = `${spec.abbr}-${item.bloom.toLowerCase()}-${KIND_ABBR[item.kind]}`;
    const n = (counters.get(cell) ?? 0) + 1;
    counters.set(cell, n);
    const key = `${cell}${n}`;
    const order = shuffled(item.options.length, `${slug}:${key}`);
    const options = order.map((from, to) => ({ id: OPTION_IDS[to] ?? String(to), label: item.options[from] ?? '' }));
    const optionIds = item.correct.map((from) => options[order.indexOf(from)]?.id ?? '').sort();
    return { key, stage: spec.stage, bloom: item.bloom, kind: item.kind, prompt: item.prompt, options, answerKey: { optionIds }, rubric: item.rubric, reviewed: false };
  });
}

/** A permutation of 0..n-1 seeded by `seed` (FNV-1a into mulberry32), stable across runs. */
function shuffled(n: number, seed: string): number[] {
  let h = 0x811c9dc5;
  for (let i = 0; i < seed.length; i++) h = Math.imul(h ^ seed.charCodeAt(i), 0x01000193);
  const random = (): number => {
    h = (h + 0x6d2b79f5) | 0;
    let t = Math.imul(h ^ (h >>> 15), 1 | h);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296;
  };
  const order = Array.from({ length: n }, (_, i) => i);
  for (let i = n - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1));
    [order[i], order[j]] = [order[j] ?? j, order[i] ?? i];
  }
  return order;
}
