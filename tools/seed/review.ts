import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import Anthropic from '@anthropic-ai/sdk';
import { z } from 'zod';
import { toStructuredSchema } from '../../src/shared/ai/json-schema';
import { PromptRegistry } from '../../src/shared/ai/prompts/prompt-registry';
import { parseSeed, readSeedFiles, type SeedTopic } from '../../src/shared/db/seed/seed-data';
import { collectBatch, replyJson, submitBatch } from './batch';
import { byPriority, FLAG_HELP, flagTopic, type Flagged, type FlagCode, type SeedItem } from './flags';
import { assertWithinCap, logSpend, openRun, reject, ROOT, SEED_DIR, writeJson } from './ledger';
import { addUsage, estimate, estimateTokens, formatEstimate, fromApiUsage, SEED_MODEL, usd, ZERO_USAGE, type Usage } from './pricing';

// seed:items-review. Reviews only flagged diagnostic items (user decision, 22 Oct 2026): flags.ts picks
// single-answer items whose key is the longest option (novice first) and items a quick check marks as
// low-confidence. Sonnet checks each flagged item against a cached rubric and returns keep, revise (with
// a rewritten item) or drop. Verdicts go to seed/_review/verdicts.json; applying them to seed/items is a
// separate, reviewed step.

const COMMAND = 'items-review';
const REVIEW_DIR = join(SEED_DIR, '_review');
const FLAGS_FILE = join(REVIEW_DIR, 'flags.json');
export const VERDICTS_FILE = join(REVIEW_DIR, 'verdicts.json');
const PROMPT = new PromptRegistry(join(ROOT, 'src', 'prompts')).get('item-review', 'v2');
/** Only verdicts from this review prompt version are counted and applied. */
export const REVIEW_PROMPT_VERSION = PROMPT.version;

const MAX_TOKENS = 8_000;
const EXPECTED_OUTPUT_TOKENS = 600; // v1 sample: 240 per novice item; later stages run longer

const verdictSchema = z.object({
  verdict: z.enum(['keep', 'revise', 'drop']),
  keyCorrect: z.boolean(),
  issues: z.array(z.string()),
  revised: z
    .object({
      prompt: z.string(),
      options: z.array(z.object({ id: z.string(), label: z.string() })),
      correctIds: z.array(z.string()),
    })
    .nullable(),
});
type Verdict = z.infer<typeof verdictSchema>;

export const verdictsFileSchema = z.record(z.string(), z.object({ promptVersion: z.string(), flags: z.array(z.string()), verdict: verdictSchema }));
export type VerdictsFile = z.infer<typeof verdictsFileSchema>;

export interface ReviewOptions {
  dryRun: boolean;
  go: boolean;
  sample?: number;
  /**
   * Skip items flagged only as longest-key whose key beats the longest distractor by less than this
   * fraction. Novice items are always reviewed (user decision, 22 Oct 2026).
   */
  minMargin: number;
}

/** Items to review: every flagged item, except non-novice longest-key-only items under the margin. */
function selected(flagged: Flagged[], minMargin: number): Flagged[] {
  return flagged.filter(
    (f) => f.item.stage === 'novice' || !(f.flags.length === 1 && f.flags[0] === 'longest-key' && (f.margin ?? 0) < minMargin),
  );
}

function reviewId(f: Flagged): string {
  return `${f.topic}--${f.item.key}`;
}

function loadFlags(): { topics: SeedTopic[]; flagged: Flagged[]; itemCount: number } {
  const seed = parseSeed(readSeedFiles(SEED_DIR));
  const byTopic = new Map<string, SeedItem[]>();
  for (const item of seed.items) byTopic.set(item.topic, [...(byTopic.get(item.topic) ?? []), item]);
  const flagged = [...byTopic].flatMap(([topic, items]) => flagTopic(topic, items)).sort(byPriority);
  return { topics: seed.topics, flagged, itemCount: seed.items.length };
}

/** Every verdict on file, any prompt version; a newer review of the same item replaces the entry. */
function loadVerdicts(): VerdictsFile {
  if (!existsSync(VERDICTS_FILE)) return {};
  return verdictsFileSchema.parse(JSON.parse(readFileSync(VERDICTS_FILE, 'utf8')));
}

function reviewed(verdicts: VerdictsFile, f: Flagged): boolean {
  return verdicts[reviewId(f)]?.promptVersion === PROMPT.version;
}

function userTurn(topics: SeedTopic[], f: Flagged): string {
  const topic = topics.find((t) => t.slug === f.topic);
  const item = {
    stage: f.item.stage,
    bloom: f.item.bloom,
    kind: f.item.kind,
    prompt: f.item.prompt,
    options: f.item.options ?? [],
    correctIds: f.item.answerKey?.optionIds ?? [],
    rubric: f.item.rubric ?? [],
  };
  return [
    `<topic>\nName: ${topic?.canonicalName ?? f.topic}\nDescription: ${topic?.description ?? ''}\n</topic>`,
    `Flags: ${f.flags.map((code) => `${code} (${FLAG_HELP[code]})`).join('; ')}`,
    `<item>\n${JSON.stringify(item, null, 2)}\n</item>`,
  ].join('\n\n');
}

function requestParams(topics: SeedTopic[], f: Flagged): Anthropic.MessageCreateParamsNonStreaming {
  return {
    model: SEED_MODEL,
    max_tokens: MAX_TOKENS,
    system: [{ type: 'text', text: PROMPT.text, cache_control: { type: 'ephemeral' } }],
    messages: [{ role: 'user', content: userTurn(topics, f) }],
    output_config: { format: { type: 'json_schema', schema: toStructuredSchema(verdictSchema) }, effort: 'medium' },
  };
}

/** A revision must keep the item's option ids and kind rules; anything else is rejected and stays pending. */
function checkRevision(f: Flagged, v: Verdict): string | undefined {
  if (v.verdict !== 'revise') return v.revised === null ? undefined : `${v.verdict} verdict carries a revision`;
  if (!v.revised) return 'revise verdict without a revision';
  const ids = (f.item.options ?? []).map((o) => o.id).sort().join(',');
  if (v.revised.options.map((o) => o.id).sort().join(',') !== ids) return 'revision changed the option ids';
  if (v.revised.options.some((o) => o.label.trim() === '') || v.revised.prompt.trim() === '') return 'revision has empty text';
  if (v.revised.correctIds.some((id) => !ids.split(',').includes(id))) return 'revision keys an unknown option';
  const single = f.item.kind !== 'multi_choice';
  if (single ? v.revised.correctIds.length !== 1 : v.revised.correctIds.length < 2) return `revision has ${v.revised.correctIds.length} correct options`;
  if (f.flags.includes('longest-key') && single) {
    const keyId = v.revised.correctIds[0];
    const key = v.revised.options.find((o) => o.id === keyId)?.label.trim().length ?? 0;
    const longestDistractor = Math.max(...v.revised.options.filter((o) => o.id !== keyId).map((o) => o.label.trim().length));
    if (key > longestDistractor) return `revision leaves the key the longest option (${key} vs ${longestDistractor} characters)`;
  }
  return undefined;
}

function accept(verdicts: VerdictsFile, f: Flagged, message: Anthropic.Message): boolean {
  const id = reviewId(f);
  const json = replyJson(COMMAND, id, message);
  if (json === undefined) return false;
  const parsed = verdictSchema.safeParse(json);
  if (!parsed.success) {
    reject(COMMAND, id, parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; '), json);
    return false;
  }
  const problem = checkRevision(f, parsed.data);
  if (problem) {
    reject(COMMAND, id, problem, json);
    return false;
  }
  verdicts[id] = { promptVersion: PROMPT.version, flags: f.flags, verdict: parsed.data };
  return true;
}

function summarise(flagged: Flagged[], itemCount: number): string[] {
  const count = (code: FlagCode): number => flagged.filter((f) => f.flags.includes(code)).length;
  const stages = ['novice', 'advanced_beginner', 'competent', 'proficient', 'expert'];
  const longestByStage = stages.map((s) => `${s} ${flagged.filter((f) => f.item.stage === s && f.flags.includes('longest-key')).length}`);
  return [
    `Flagged ${flagged.length} of ${itemCount} items (${((100 * flagged.length) / Math.max(1, itemCount)).toFixed(1)}%):`,
    ...(Object.keys(FLAG_HELP) as FlagCode[]).map((code) => `  ${code.padEnd(24)} ${String(count(code)).padStart(5)}  ${FLAG_HELP[code]}`),
    `  longest-key by stage: ${longestByStage.join(', ')}`,
    `  items to review with --min-margin 0 / 0.1 / 0.2 (novice always in full): ${[0, 0.1, 0.2].map((m) => selected(flagged, m).length).join(' / ')}`,
    `  (an item can carry several flags; the report is seed/_review/flags.json, in review order)`,
  ];
}

function printVerdicts(verdicts: VerdictsFile): void {
  const all = Object.values(verdicts).filter((e) => e.promptVersion === PROMPT.version);
  const n = (v: Verdict['verdict']): number => all.filter((e) => e.verdict.verdict === v).length;
  const wrongKey = all.filter((e) => !e.verdict.keyCorrect).length;
  process.stdout.write(`Verdicts so far with ${PROMPT.version}: ${all.length} (keep ${n('keep')}, revise ${n('revise')}, drop ${n('drop')}; original key wrong or not single: ${wrongKey}).\n`);
}

export async function runReview(options: ReviewOptions): Promise<void> {
  const write = (line: string): boolean => process.stdout.write(`${line}\n`);
  const { topics, flagged, itemCount } = loadFlags();
  const byId = new Map(flagged.map((f) => [reviewId(f), f]));
  const verdicts = loadVerdicts();

  const open = openRun(COMMAND);
  if (open) {
    if (options.dryRun) {
      write(`Batch ${open.batchId} (${open.requests} requests) is still open; a real run collects it at no extra cost.`);
      return;
    }
    await collect(new Anthropic(), byId, verdicts, open.batchId);
    printVerdicts(verdicts);
    return;
  }

  for (const line of summarise(flagged, itemCount)) write(line);
  writeJson(FLAGS_FILE, {
    generatedAt: new Date().toISOString(),
    items: itemCount,
    flagged: flagged.map((f) => ({ id: reviewId(f), stage: f.item.stage, bloom: f.item.bloom, kind: f.item.kind, flags: f.flags, lengthRatio: f.lengthRatio && Number(f.lengthRatio.toFixed(2)), margin: f.margin && Number(f.margin.toFixed(2)) })),
  });

  const pending = selected(flagged, options.minMargin).filter((f) => !reviewed(verdicts, f));
  const current = flagged.filter((f) => reviewed(verdicts, f)).length;
  write(`Review (--min-margin ${options.minMargin}, novice in full): ${current} flagged items reviewed with ${PROMPT.name}/${PROMPT.version}, ${pending.length} pending.`);
  if (pending.length === 0) return;

  const targets = options.sample === undefined ? pending : pending.slice(0, options.sample);
  const batch = options.sample === undefined;
  const prefixTokens = estimateTokens(PROMPT.text) + 300; // + output schema
  const suffixTokens = Math.max(...targets.map((f) => estimateTokens(userTurn(topics, f))));
  const est = estimate(targets.length, { prefixTokens, suffixTokens, outputTokens: EXPECTED_OUTPUT_TOKENS }, batch);
  write(formatEstimate(batch ? 'seed:items-review' : `seed:items-review --sample ${targets.length} (highest priority first)`, est, batch));
  if (options.dryRun) return;
  if (!options.go) {
    write('Not started: rerun with --go once the estimate is approved.');
    return;
  }
  assertWithinCap(est.usdNoCache);

  const client = new Anthropic();
  if (!batch) {
    await runSample(client, topics, targets, verdicts);
  } else {
    const requests = targets.map((f) => ({ custom_id: reviewId(f), params: requestParams(topics, f) }));
    await collect(client, byId, verdicts, await submitBatch(client, COMMAND, PROMPT.version, requests));
  }
  printVerdicts(verdicts);
}

async function runSample(client: Anthropic, topics: SeedTopic[], targets: Flagged[], verdicts: VerdictsFile): Promise<void> {
  let usage: Usage = ZERO_USAGE;
  let accepted = 0;
  try {
    for (const f of targets) {
      const message = await client.messages.create(requestParams(topics, f), { timeout: 90_000, maxRetries: 2 });
      usage = addUsage(usage, fromApiUsage(message.usage));
      if (accept(verdicts, f, message)) accepted++;
    }
  } finally {
    writeJson(VERDICTS_FILE, verdicts);
    const cost = logSpend({ command: `${COMMAND} --sample`, batch: false, requests: targets.length, usage, ref: PROMPT.version });
    process.stdout.write(`Sample done: ${accepted}/${targets.length} verdicts accepted, actual cost ${usd(cost)}.\n`);
  }
}

async function collect(client: Anthropic, byId: Map<string, Flagged>, verdicts: VerdictsFile, batchId: string): Promise<void> {
  try {
    await collectBatch(client, COMMAND, batchId, (id, message) => {
      const f = byId.get(id);
      if (!f) {
        reject(COMMAND, id, 'unknown custom_id (item no longer flagged?)');
        return false;
      }
      return accept(verdicts, f, message);
    });
  } finally {
    writeJson(VERDICTS_FILE, verdicts);
  }
}
