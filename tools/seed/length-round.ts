import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import Anthropic from '@anthropic-ai/sdk';
import { z } from 'zod';
import { toStructuredSchema } from '../../src/shared/ai/json-schema';
import { PromptRegistry } from '../../src/shared/ai/prompts/prompt-registry';
import { parseSeed, readSeedFiles } from '../../src/shared/db/seed/seed-data';
import { lengthCue } from './apply';
import { collectBatch, replyJson, submitBatch } from './batch';
import { assertWithinCap, logSpend, openRun, reject, ROOT, SEED_DIR, writeJson } from './ledger';
import { addUsage, estimate, estimateTokens, formatEstimate, fromApiUsage, SEED_MODEL, usd, ZERO_USAGE, type Usage } from './pricing';

// seed:length-round (user, 3 Nov 2026). Single-answer items whose key is the shortest option by a clear
// margin get their distractors rewritten so length gives no cue either way. Only distractor labels change:
// the prompt and the key's text are kept byte for byte, so the key's correctness can't change and the
// rubric stays valid. A rewrite is accepted only if the key ends up neither the one shortest nor the one
// longest option. The /demo items (signed off by the user, served from their own copy) are excluded.

const COMMAND = 'length-round';
const PROMPT = new PromptRegistry(join(ROOT, 'src', 'prompts')).get('item-length', 'v1');
const ITEMS_DIR = join(SEED_DIR, 'items');
const WORK_FILE = join(SEED_DIR, '_review', 'length-round.json');
const APPLIED_FILE = join(SEED_DIR, '_review', 'length-round-applied.json');
const DEMO_FILE = join(ROOT, '..', 'ui', 'src', 'features', 'demo', 'data', 'approved.json');

/** Clear margin (user, 3 Nov 2026): key at most 0.80 x the shortest distractor and at least 6 characters shorter. */
export const MAX_RATIO = 0.8;
export const MIN_GAP = 6;
const EXPECTED_OUTPUT_TOKENS = 400;

interface Option {
  id: string;
  label: string;
}
interface Item {
  key: string;
  stage: string;
  bloom: string;
  kind: string;
  prompt: string;
  options?: Option[];
  answerKey?: { optionIds?: string[] };
}
interface Target {
  id: string;
  topic: string;
  item: Item;
}

/** True when the key is the one shortest option by the clear margin. */
export function clearlyShortest(options: Option[], keyId: string): boolean {
  const key = options.find((o) => o.id === keyId)?.label.trim().length ?? 0;
  const shortest = Math.min(...options.filter((o) => o.id !== keyId).map((o) => o.label.trim().length));
  return key <= MAX_RATIO * shortest && shortest - key >= MIN_GAP;
}

/** Problems with a rewrite: same distractor ids, non-empty, distinct, key text untouched, no length cue. */
export function checkRewrite(item: Item, distractors: Option[]): string[] {
  const keyId = item.answerKey?.optionIds?.[0] ?? '';
  const original = item.options ?? [];
  const wanted = original.filter((o) => o.id !== keyId).map((o) => o.id).sort().join(',');
  const problems: string[] = [];
  if (distractors.map((d) => d.id).sort().join(',') !== wanted) problems.push('distractor ids changed');
  if (distractors.some((d) => d.label.trim() === '')) problems.push('empty distractor');
  const key = original.find((o) => o.id === keyId);
  const next = original.map((o) => (o.id === keyId ? o : { id: o.id, label: distractors.find((d) => d.id === o.id)?.label.trim() ?? '' }));
  if (new Set(next.map((o) => o.label.toLowerCase())).size !== next.length) problems.push('duplicate options');
  if (key && distractors.some((d) => d.label.trim().toLowerCase() === key.label.trim().toLowerCase())) problems.push('a distractor repeats the key');
  const cue = lengthCue(next, [keyId]);
  if (cue) problems.push(`the key would be the ${cue} option`);
  return problems;
}

function demoIds(): Set<string> {
  if (!existsSync(DEMO_FILE)) throw new Error(`Demo item list not found at ${DEMO_FILE}; it must be excluded`);
  return new Set([...JSON.stringify(JSON.parse(readFileSync(DEMO_FILE, 'utf8'))).matchAll(/"([a-z0-9-]+--[a-z]{3}-c[1-6]-[a-z]{2}\d+)"/g)].map((m) => m[1] ?? ''));
}

function targets(): { list: Target[]; demoExcluded: number } {
  const seed = parseSeed(readSeedFiles(SEED_DIR));
  const demo = demoIds();
  let demoExcluded = 0;
  const list: Target[] = [];
  for (const item of seed.items) {
    const keyIds = item.answerKey?.optionIds ?? [];
    if (keyIds.length !== 1 || !item.options || !keyIds[0] || !clearlyShortest(item.options, keyIds[0])) continue;
    const id = `${item.topic}--${item.key}`;
    if (demo.has(id)) {
      demoExcluded++;
      continue;
    }
    list.push({ id, topic: item.topic, item });
  }
  return { list, demoExcluded };
}

const rewriteSchema = z.object({ distractors: z.array(z.object({ id: z.string(), label: z.string().trim().min(1).max(300) })) });
const workSchema = z.record(z.string(), z.object({ promptVersion: z.string(), distractors: z.array(z.object({ id: z.string(), label: z.string() })) }));
type Work = z.infer<typeof workSchema>;

function loadWork(): Work {
  return existsSync(WORK_FILE) ? workSchema.parse(JSON.parse(readFileSync(WORK_FILE, 'utf8'))) : {};
}

function request(t: Target): Anthropic.MessageCreateParamsNonStreaming {
  const keyId = t.item.answerKey?.optionIds?.[0];
  const view = {
    stage: t.item.stage,
    bloom: t.item.bloom,
    question: t.item.prompt,
    key: t.item.options?.find((o) => o.id === keyId),
    distractors: t.item.options?.filter((o) => o.id !== keyId).map((o) => ({ ...o, length: o.label.trim().length })),
    keyLength: t.item.options?.find((o) => o.id === keyId)?.label.trim().length,
  };
  return {
    model: SEED_MODEL,
    max_tokens: 4_000,
    system: [{ type: 'text', text: PROMPT.text, cache_control: { type: 'ephemeral' } }],
    messages: [{ role: 'user', content: `<item>\n${JSON.stringify(view, null, 2)}\n</item>` }],
    output_config: { format: { type: 'json_schema', schema: toStructuredSchema(z.object({ distractors: z.array(z.object({ id: z.string(), label: z.string() })) })) }, effort: 'medium' },
  };
}

function accept(work: Work, t: Target, message: Anthropic.Message): boolean {
  const json = replyJson(COMMAND, t.id, message);
  if (json === undefined) return false;
  const parsed = rewriteSchema.safeParse(json);
  if (!parsed.success) {
    reject(COMMAND, t.id, 'malformed rewrite', json);
    return false;
  }
  const problems = checkRewrite(t.item, parsed.data.distractors);
  if (problems.length > 0) {
    reject(COMMAND, t.id, problems.join('; '), json);
    return false;
  }
  work[t.id] = { promptVersion: PROMPT.version, distractors: parsed.data.distractors.map((d) => ({ id: d.id, label: d.label.trim() })) };
  return true;
}

export interface LengthRoundOptions {
  stage: 'rewrite' | 'apply';
  dryRun: boolean;
  go: boolean;
  sample?: number;
}

export async function runLengthRound(o: LengthRoundOptions): Promise<void> {
  const write = (line: string): boolean => process.stdout.write(`${line}\n`);
  if (o.stage === 'apply') {
    applyRewrites(o.dryRun, write);
    return;
  }
  const { list, demoExcluded } = targets();
  const work = loadWork();
  const byId = new Map(list.map((t) => [t.id, t]));
  const pending = list.filter((t) => work[t.id]?.promptVersion !== PROMPT.version);
  write(`length-round: ${list.length} items where the key is the shortest option by the clear margin (<= ${MAX_RATIO} x the shortest distractor and >= ${MIN_GAP} chars shorter); ${demoExcluded} /demo items excluded; ${pending.length} pending.`);

  const open = openRun(COMMAND);
  if (open) {
    if (o.dryRun) {
      write(`Batch ${open.batchId} is still open; a real run collects it at no extra cost.`);
      return;
    }
    await collect(new Anthropic(), open.batchId, work, byId);
    return;
  }
  if (pending.length === 0) return;
  const chosen = o.sample === undefined ? pending : pending.slice(0, o.sample);
  const batch = o.sample === undefined;
  const suffix = Math.max(...chosen.map((t) => estimateTokens(JSON.stringify(request(t).messages))));
  const est = estimate(chosen.length, { prefixTokens: estimateTokens(PROMPT.text) + 200, suffixTokens: suffix, outputTokens: EXPECTED_OUTPUT_TOKENS }, batch);
  write(formatEstimate(`seed:length-round${batch ? '' : ` --sample ${chosen.length}`}`, est, batch));
  if (o.dryRun) return;
  if (!o.go) {
    write('Not started: rerun with --go once the estimate is approved.');
    return;
  }
  assertWithinCap(est.usdNoCache);
  const client = new Anthropic();
  if (batch) {
    await collect(client, await submitBatch(client, COMMAND, PROMPT.version, chosen.map((t) => ({ custom_id: t.id, params: request(t) }))), work, byId);
    return;
  }
  let usage: Usage = ZERO_USAGE;
  let accepted = 0;
  try {
    for (const t of chosen) {
      const message = await client.messages.stream(request(t), { maxRetries: 0 }).finalMessage();
      usage = addUsage(usage, fromApiUsage(message.usage));
      if (accept(work, t, message)) accepted++;
    }
  } finally {
    writeJson(WORK_FILE, work);
    const cost = logSpend({ command: `${COMMAND} --sample`, batch: false, requests: chosen.length, usage, ref: PROMPT.version });
    write(`Sample done: ${accepted}/${chosen.length} accepted, actual cost ${usd(cost)}.`);
  }
}

async function collect(client: Anthropic, batchId: string, work: Work, byId: Map<string, Target>): Promise<void> {
  try {
    await collectBatch(client, COMMAND, batchId, (id, message) => {
      const t = byId.get(id);
      if (!t) {
        reject(COMMAND, id, 'not a target');
        return false;
      }
      return accept(work, t, message);
    });
  } finally {
    writeJson(WORK_FILE, work);
  }
}

/** Writes accepted rewrites into seed/items (distractor labels only), parser-checked; reports both cues. */
function applyRewrites(dryRun: boolean, write: (line: string) => boolean): void {
  const work = loadWork();
  const applied = new Set<string>(existsSync(APPLIED_FILE) ? (JSON.parse(readFileSync(APPLIED_FILE, 'utf8')) as string[]) : []);
  const demo = demoIds();
  const files = new Map<string, { version: 1; topic: string; items: Item[] }>();
  let changed = 0;
  const skipped: string[] = [];
  for (const [id, entry] of Object.entries(work)) {
    if (applied.has(id)) continue;
    if (demo.has(id)) {
      skipped.push(`${id}: /demo item`);
      continue;
    }
    const [topic = '', key = ''] = id.split('--');
    if (!files.has(topic)) files.set(topic, JSON.parse(readFileSync(join(ITEMS_DIR, `${topic}.json`), 'utf8')) as { version: 1; topic: string; items: Item[] });
    const item = files.get(topic)?.items.find((i) => i.key === key);
    if (!item?.options) {
      skipped.push(`${id}: item not found`);
      continue;
    }
    // Re-checked against the item as it is now: guards both length directions and the untouched key.
    const problems = checkRewrite(item, entry.distractors);
    if (problems.length > 0) {
      skipped.push(`${id}: ${problems.join('; ')}`);
      continue;
    }
    const keyId = item.answerKey?.optionIds?.[0];
    item.options = item.options.map((o) => (o.id === keyId ? o : { id: o.id, label: entry.distractors.find((d) => d.id === o.id)?.label ?? o.label }));
    applied.add(id);
    changed++;
  }
  const raw = readSeedFiles(SEED_DIR);
  for (const [topic, file] of files) raw.items[topic] = JSON.parse(JSON.stringify(file)) as unknown;
  const parsed = parseSeed(raw);
  let single = 0;
  let longest = 0;
  let shortest = 0;
  for (const item of parsed.items) {
    const ids = item.answerKey?.optionIds ?? [];
    if (ids.length !== 1 || !item.options) continue;
    single++;
    const cue = lengthCue(item.options, ids);
    if (cue === 'longest') longest++;
    if (cue === 'shortest') shortest++;
  }
  const pct = (n: number): string => `${n}/${single} (${Math.round((100 * n) / single)}%)`;
  write(`Rewrites applied: ${changed}; skipped: ${skipped.length}. Parser check passed: ${parsed.topics.length} topics, ${parsed.items.length} items.`);
  for (const line of skipped.slice(0, 10)) write(`  skipped ${line}`);
  write(`Whole bank, single-answer items: key is the longest option in ${pct(longest)} and the shortest in ${pct(shortest)}; chance is 25% each.`);
  if (dryRun) {
    write('Dry run: nothing written.');
    return;
  }
  for (const [topic, file] of files) writeJson(join(ITEMS_DIR, `${topic}.json`), file);
  writeJson(APPLIED_FILE, [...applied].sort());
  write(`Wrote ${files.size} item files and seed/_review/length-round-applied.json.`);
}
