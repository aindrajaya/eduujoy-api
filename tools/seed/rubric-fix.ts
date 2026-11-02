import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import Anthropic from '@anthropic-ai/sdk';
import { z } from 'zod';
import { toStructuredSchema } from '../../src/shared/ai/json-schema';
import { PromptRegistry } from '../../src/shared/ai/prompts/prompt-registry';
import { parseSeed, readSeedFiles } from '../../src/shared/db/seed/seed-data';
import { collectBatch, replyJson, submitBatch } from './batch';
import { assertWithinCap, logSpend, openRun, reject, ROOT, SEED_DIR, writeJson } from './ledger';
import { addUsage, estimate, estimateTokens, formatEstimate, fromApiUsage, SEED_MODEL, usd, ZERO_USAGE, type Usage } from './pricing';

// seed:rubric-fix (user, option C, 3 Nov 2026). The length round reworded distractors of 288 items, so
// rubric sentences about the old distractors may be stale. For each item:
//   rewrite  (paid)  the model marks the key-explanation sentences and rewrites only the others; code
//                    keeps the key sentences byte for byte (it rebuilds the rubric around them)
//   verify   (paid)  a separate model check: wrong-option sentences match the current options, and the key
//                    explanation is intact
//   finalize (free)  the word check (no rubric word from a removed distractor) must pass too; an item that
//                    fails anything is reverted to its options and rubric from before the length round
// Baseline: seed/_review/rubric-fix-before.json (the 288 items at the branch's base commit).

const PROMPTS = new PromptRegistry(join(ROOT, 'src', 'prompts'));
const FIX_PROMPT = PROMPTS.get('rubric-fix', 'v1');
const CHECK_PROMPT = PROMPTS.get('rubric-check', 'v1');
const ITEMS_DIR = join(SEED_DIR, 'items');
const BEFORE_FILE = join(SEED_DIR, '_review', 'rubric-fix-before.json');
const WORK_FILE = join(SEED_DIR, '_review', 'rubric-fix.json');
const COMMAND = 'rubric-fix';

interface Option {
  id: string;
  label: string;
}
interface Item {
  key: string;
  prompt: string;
  options?: Option[];
  answerKey?: { optionIds?: string[] };
  rubric?: string[];
}

/** Splits a rubric string into sentences and the exact separators between them, so a rebuild is byte-exact. */
export function splitSentences(text: string): { sentences: string[]; separators: string[] } {
  const parts = text.split(/(?<=[.!?])(\s+)(?=[A-Z0-9"'`(])/);
  const sentences: string[] = [];
  const separators: string[] = [];
  parts.forEach((p, i) => (i % 2 === 0 ? sentences.push(p) : separators.push(p)));
  return { sentences, separators };
}

interface Numbered {
  index: number;
  string: number;
  text: string;
}

export function numberRubric(rubric: string[]): Numbered[] {
  let index = 0;
  return rubric.flatMap((s, string) => splitSentences(s).sentences.map((text) => ({ index: index++, string, text })));
}

/**
 * Rebuilds the rubric with updates applied. Key sentences can't be updated; deleted sentences drop out with
 * their separator; a string left empty is dropped. Returns undefined when nothing would remain.
 */
export function rebuildRubric(rubric: string[], keySentences: number[], updates: { index: number; text: string }[]): string[] | undefined {
  const byIndex = new Map(updates.map((u) => [u.index, u.text.trim()]));
  if (keySentences.some((k) => byIndex.has(k))) throw new Error('an update targets a key sentence');
  let index = 0;
  const out: string[] = [];
  for (const s of rubric) {
    const { sentences, separators } = splitSentences(s);
    let rebuilt = '';
    sentences.forEach((sentence, i) => {
      const text = byIndex.has(index) ? (byIndex.get(index) ?? '') : sentence;
      index++;
      if (text === '') return;
      rebuilt += rebuilt === '' ? text : `${separators[i - 1] ?? ' '}${text}`;
    });
    if (rebuilt !== '') out.push(rebuilt);
  }
  return out.length > 0 ? out : undefined;
}

/** True when every key sentence of the original rubric appears byte for byte in the rebuilt one. */
export function keySentencesKept(before: string[], after: string[], keySentences: number[]): boolean {
  const numbered = numberRubric(before);
  const joined = after.join('\n');
  return keySentences.every((k) => {
    const sentence = numbered.find((n) => n.index === k)?.text;
    return sentence !== undefined && joined.includes(sentence);
  });
}

// ---------- the free word check (the lead's check, kept as code) ----------

const STOP = new Set('the and that this with from into than then them they their there what when which while where your have been does doesnt dont because about would could should only also more most some such each other same just over under after before between using used uses make makes made like real'.split(' '));
const stem = (w: string): string => w.replace(/(ings|ing|edly|ed|es|s)$/, '');
function words(text: string): Set<string> {
  return new Set((text.toLowerCase().match(/[a-z0-9]+/g) ?? []).filter((w) => w.length >= 4 && !STOP.has(w)).map(stem));
}

/** Rubric words that came from a removed distractor wording and appear in no current option or the prompt. */
export function staleWords(before: Item, now: { prompt: string; options: Option[]; rubric: string[] }): string[] {
  const keyId = before.answerKey?.optionIds?.[0];
  const current = new Set([...words(now.prompt), ...now.options.flatMap((o) => [...words(o.label)])]);
  const lost = new Set<string>();
  for (const o of before.options ?? []) if (o.id !== keyId) for (const w of words(o.label)) if (!current.has(w)) lost.add(w);
  const rubric = words(now.rubric.join(' '));
  return [...lost].filter((w) => rubric.has(w));
}

// ---------- work ----------

const workSchema = z.object({
  batches: z.array(z.string()),
  items: z.record(
    z.string(),
    z.object({
      fix: z.object({ promptVersion: z.string(), keySentences: z.array(z.number().int()), updates: z.array(z.object({ index: z.number().int(), text: z.string() })), rubric: z.array(z.string()) }).optional(),
      check: z.object({ promptVersion: z.string(), matchesOptions: z.boolean(), keyExplanationIntact: z.boolean(), problems: z.array(z.string()) }).optional(),
    }),
  ),
});
type Work = z.infer<typeof workSchema>;

function loadWork(): Work {
  return existsSync(WORK_FILE) ? workSchema.parse(JSON.parse(readFileSync(WORK_FILE, 'utf8'))) : { batches: [], items: {} };
}

function loadBefore(): Map<string, Item> {
  const file = z.object({ items: z.record(z.string(), z.unknown()) }).parse(JSON.parse(readFileSync(BEFORE_FILE, 'utf8')));
  return new Map(Object.entries(file.items).map(([id, item]) => [id, item as Item]));
}

function currentItem(id: string): Item {
  const [topic = '', key = ''] = id.split('--');
  const item = (JSON.parse(readFileSync(join(ITEMS_DIR, `${topic}.json`), 'utf8')) as { items: Item[] }).items.find((i) => i.key === key);
  if (!item) throw new Error(`${id} not found`);
  return item;
}

function optionsView(item: Item): { id: string; label: string; correct: boolean }[] {
  const keyId = item.answerKey?.optionIds?.[0];
  return (item.options ?? []).map((o) => ({ id: o.id, label: o.label, correct: o.id === keyId }));
}

function request(system: string, user: string, schema: z.ZodType): Anthropic.MessageCreateParamsNonStreaming {
  return {
    model: SEED_MODEL,
    max_tokens: 4_000,
    system: [{ type: 'text', text: system, cache_control: { type: 'ephemeral' } }],
    messages: [{ role: 'user', content: user }],
    output_config: { format: { type: 'json_schema', schema: toStructuredSchema(schema) }, effort: 'medium' },
  };
}

const fixReply = z.object({ keySentences: z.array(z.number()), updates: z.array(z.object({ index: z.number(), text: z.string() })) });
const checkReply = z.object({ matchesOptions: z.boolean(), keyExplanationIntact: z.boolean(), problems: z.array(z.string()) });

function fixRequest(before: Item, now: Item): Anthropic.MessageCreateParamsNonStreaming {
  const view = {
    question: now.prompt,
    currentOptions: optionsView(now),
    optionsBefore: optionsView(before),
    rubricSentences: numberRubric(now.rubric ?? []).map(({ index, text }) => ({ index, text })),
  };
  return request(FIX_PROMPT.text, `<item>\n${JSON.stringify(view, null, 2)}\n</item>`, fixReply);
}

function checkRequest(now: Item, rubricBefore: string[], rubricAfter: string[]): Anthropic.MessageCreateParamsNonStreaming {
  const view = { question: now.prompt, currentOptions: optionsView(now), rubricBefore, rubricAfter };
  return request(CHECK_PROMPT.text, `<item>\n${JSON.stringify(view, null, 2)}\n</item>`, checkReply);
}

function acceptFix(work: Work, id: string, now: Item, message: Anthropic.Message): boolean {
  const json = replyJson(COMMAND, `${id} fix`, message);
  const parsed = fixReply.safeParse(json);
  if (json === undefined || !parsed.success) {
    if (json !== undefined) reject(COMMAND, `${id} fix`, 'malformed reply', json);
    return false;
  }
  const rubric = now.rubric ?? [];
  const count = numberRubric(rubric).length;
  const keySentences = [...new Set(parsed.data.keySentences.map(Math.trunc))].filter((k) => k >= 0 && k < count);
  const updates = parsed.data.updates.map((u) => ({ index: Math.trunc(u.index), text: u.text }));
  const problem =
    keySentences.length === 0
      ? 'no key sentence marked'
      : updates.some((u) => u.index < 0 || u.index >= count)
        ? 'update index out of range'
        : updates.some((u) => keySentences.includes(u.index))
          ? 'an update targets a key sentence'
          : undefined;
  const rebuilt = problem ? undefined : rebuildRubric(rubric, keySentences, updates);
  if (problem || !rebuilt || !keySentencesKept(rubric, rebuilt, keySentences) || rebuilt.some((s) => s.length > 500)) {
    reject(COMMAND, `${id} fix`, problem ?? 'rebuilt rubric empty, too long or lost a key sentence', parsed.data);
    return false;
  }
  const entry = (work.items[id] ??= {});
  entry.fix = { promptVersion: FIX_PROMPT.version, keySentences, updates, rubric: rebuilt };
  delete entry.check;
  return true;
}

function acceptCheck(work: Work, id: string, message: Anthropic.Message): boolean {
  const json = replyJson(COMMAND, `${id} check`, message);
  const parsed = checkReply.safeParse(json);
  if (json === undefined || !parsed.success) {
    if (json !== undefined) reject(COMMAND, `${id} check`, 'malformed reply', json);
    return false;
  }
  const entry = (work.items[id] ??= {});
  entry.check = { promptVersion: CHECK_PROMPT.version, ...parsed.data };
  return true;
}

export interface RubricFixOptions {
  stage: 'rewrite' | 'verify' | 'finalize';
  dryRun: boolean;
  go: boolean;
  sample?: number;
}

export async function runRubricFix(o: RubricFixOptions): Promise<void> {
  const write = (line: string): boolean => process.stdout.write(`${line}\n`);
  const before = loadBefore();
  const work = loadWork();
  if (o.stage === 'finalize') {
    finalize(before, work, o.dryRun, write);
    return;
  }
  // Items without a rubric (removed earlier when their key changed) have nothing stale to fix.
  const ids = [...before.keys()].filter((id) => (currentItem(id).rubric ?? []).length > 0);
  const pending =
    o.stage === 'rewrite'
      ? ids.filter((id) => work.items[id]?.fix?.promptVersion !== FIX_PROMPT.version)
      : ids.filter((id) => work.items[id]?.fix && work.items[id].check?.promptVersion !== CHECK_PROMPT.version);
  write(`rubric-fix ${o.stage}: ${ids.length} items, ${ids.filter((id) => work.items[id]?.fix).length} rewritten, ${ids.filter((id) => work.items[id]?.check).length} checked; ${pending.length} pending.`);
  const command = `${COMMAND}-${o.stage}`;
  const open = openRun(command);
  if (open) {
    if (o.dryRun) {
      write(`Batch ${open.batchId} is still open; a real run collects it at no extra cost.`);
      return;
    }
    await collect(new Anthropic(), command, open.batchId, work, o.stage);
    return;
  }
  if (pending.length === 0) return;
  const chosen = o.sample === undefined ? pending : pending.slice(0, o.sample);
  const batch = o.sample === undefined;
  const build = (id: string): Anthropic.MessageCreateParamsNonStreaming => {
    const now = currentItem(id);
    const fix = work.items[id]?.fix;
    return o.stage === 'rewrite' || !fix ? fixRequest(before.get(id) as Item, now) : checkRequest(now, now.rubric ?? [], fix.rubric);
  };
  const prompt = o.stage === 'rewrite' ? FIX_PROMPT : CHECK_PROMPT;
  const suffix = Math.max(...chosen.map((id) => estimateTokens(JSON.stringify(build(id).messages))));
  const est = estimate(chosen.length, { prefixTokens: estimateTokens(prompt.text) + 200, suffixTokens: suffix, outputTokens: o.stage === 'rewrite' ? 500 : 300 }, batch);
  write(formatEstimate(`seed:rubric-fix --stage ${o.stage}${batch ? '' : ` --sample ${chosen.length}`}`, est, batch));
  if (o.dryRun) return;
  if (!o.go) {
    write('Not started: rerun with --go once the estimate is approved.');
    return;
  }
  assertWithinCap(est.usdNoCache);
  const client = new Anthropic();
  if (batch) {
    const id = await submitBatch(client, command, prompt.version, chosen.map((itemId) => ({ custom_id: itemId, params: build(itemId) })));
    work.batches.push(id);
    writeJson(WORK_FILE, work);
    await collect(client, command, id, work, o.stage);
    return;
  }
  let usage: Usage = ZERO_USAGE;
  let accepted = 0;
  try {
    for (const id of chosen) {
      const message = await client.messages.stream(build(id), { maxRetries: 0 }).finalMessage();
      usage = addUsage(usage, fromApiUsage(message.usage));
      if (o.stage === 'rewrite' ? acceptFix(work, id, currentItem(id), message) : acceptCheck(work, id, message)) accepted++;
    }
  } finally {
    writeJson(WORK_FILE, work);
    const cost = logSpend({ command: `${command} --sample`, batch: false, requests: chosen.length, usage, ref: prompt.version });
    write(`Sample done: ${accepted}/${chosen.length} accepted, actual cost ${usd(cost)}.`);
  }
}

async function collect(client: Anthropic, command: string, batchId: string, work: Work, stage: 'rewrite' | 'verify'): Promise<void> {
  if (!work.batches.includes(batchId)) work.batches.push(batchId);
  try {
    await collectBatch(client, command, batchId, (id, message) => (stage === 'rewrite' ? acceptFix(work, id, currentItem(id), message) : acceptCheck(work, id, message)));
  } finally {
    writeJson(WORK_FILE, work);
  }
}

/** Writes fixed rubrics where every check passes and reverts every other item; parser-checked. */
function finalize(before: Map<string, Item>, work: Work, dryRun: boolean, write: (line: string) => boolean): void {
  const files = new Map<string, { items: Item[] }>();
  const outcome: Record<string, { result: 'fixed' | 'reverted'; reason?: string }> = {};
  for (const [id, original] of before) {
    const [topic = '', key = ''] = id.split('--');
    if (!files.has(topic)) files.set(topic, JSON.parse(readFileSync(join(ITEMS_DIR, `${topic}.json`), 'utf8')) as { items: Item[] });
    const file = files.get(topic);
    const index = file?.items.findIndex((i) => i.key === key) ?? -1;
    const now = file?.items[index];
    if (!file || !now) throw new Error(`${id} not found`);
    if ((now.rubric ?? []).length === 0) {
      outcome[id] = { result: 'fixed', reason: 'no rubric to fix' };
      continue;
    }
    const entry = work.items[id];
    const fix = entry?.fix?.promptVersion === FIX_PROMPT.version ? entry.fix : undefined;
    const check = entry?.check?.promptVersion === CHECK_PROMPT.version ? entry.check : undefined;
    let reason: string | undefined;
    if (!fix) reason = 'no accepted rubric rewrite';
    else if (!check) reason = 'not verified';
    else if (!check.matchesOptions || !check.keyExplanationIntact) reason = `model check: ${check.problems.join(' ') || 'failed'}`;
    else if (!keySentencesKept(now.rubric ?? [], fix.rubric, fix.keySentences)) reason = 'a key sentence changed';
    else {
      const stale = staleWords(original, { prompt: now.prompt, options: now.options ?? [], rubric: fix.rubric });
      if (stale.length > 0) reason = `word check: ${stale.join(', ')}`;
    }
    if (reason) {
      // Option A for this item: back to its options and rubric from before the length round.
      file.items[index] = { ...now, options: original.options, rubric: original.rubric };
      outcome[id] = { result: 'reverted', reason };
    } else {
      file.items[index] = { ...now, rubric: fix ? fix.rubric : now.rubric };
      outcome[id] = { result: 'fixed' };
    }
  }
  const raw = readSeedFiles(SEED_DIR);
  for (const [topic, file] of files) raw.items[topic] = JSON.parse(JSON.stringify({ version: 1, topic, ...file })) as unknown;
  const parsed = parseSeed(raw);
  const fixed = Object.values(outcome).filter((x) => x.result === 'fixed').length;
  const reverted = Object.values(outcome).filter((x) => x.result === 'reverted').length;
  write(`rubric-fix finalize: fixed ${fixed}, reverted ${reverted} (of ${before.size}). Parser check passed: ${parsed.items.length} items.`);
  if (dryRun) {
    write('Dry run: nothing written.');
    return;
  }
  for (const [topic, file] of files) writeJson(join(ITEMS_DIR, `${topic}.json`), { version: 1, topic, ...file });
  writeJson(join(SEED_DIR, '_review', 'rubric-fix-outcome.json'), outcome);
  write(`Wrote ${files.size} item files and seed/_review/rubric-fix-outcome.json.`);
}
