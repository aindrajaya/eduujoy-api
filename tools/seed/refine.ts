import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import Anthropic from '@anthropic-ai/sdk';
import { z } from 'zod';
import { toStructuredSchema } from '../../src/shared/ai/json-schema';
import { PromptRegistry } from '../../src/shared/ai/prompts/prompt-registry';
import { parseSeed, readSeedFiles, type SeedTopic } from '../../src/shared/db/seed/seed-data';
import { collectBatch, replyJson, submitBatch } from './batch';
import { assertWithinCap, logSpend, openRun, reject, ROOT, SEED_DIR, writeJson } from './ledger';
import { addUsage, estimate, estimateTokens, formatEstimate, fromApiUsage, SEED_MODEL, usd, ZERO_USAGE, type Usage } from './pricing';

// seed:topics-refine (docs/prompts/02-seed-resolve-fix.md). Near-neighbour topics, read from the recorded
// gemini-embedding-2 topic vectors in test/fixtures/catalog/embeddings.json, get a sharper description
// and aliases so learner phrases resolve to the right one. Only `description` and `aliases` change; slugs,
// names, parents and prerequisites stay. Accepted answers wait in seed/_work/topics-refine.json, so a rerun
// only pays for topics still missing; seed/topics.json is rewritten once all targets are answered.

const COMMAND = 'topics-refine';
const TOPICS_FILE = join(SEED_DIR, 'topics.json');
const ANSWERS_FILE = join(SEED_DIR, '_work', 'topics-refine.json');
const EMBEDDINGS_FILE = join(ROOT, 'test', 'fixtures', 'catalog', 'embeddings.json');
/** Eval phrases must never become exact aliases: they would skip the embedding path they measure. */
const EVAL_FILES = [join(ROOT, 'test', 'fixtures', 'catalog', 'golden.json'), join(SEED_DIR, '_eval', 'topic-resolve-holdout.json'), join(SEED_DIR, '_eval', 'topic-resolve-holdout-v2.json')];
const PROMPT = new PromptRegistry(join(ROOT, 'src', 'prompts')).get('topic-refine', 'v1');

/** Named in the task: the held-out failures (geometry vs trigonometry, world-history, spanish). */
const ALWAYS = ['geometry', 'trigonometry', 'world-history', 'spanish'];
const NEIGHBOURS = 6;
const MAX_EXPLICIT_NEIGHBOURS = 12;
const MAX_TOKENS = 4_000;
const EXPECTED_OUTPUT_TOKENS = 600;
const MAX_ALIASES = 10;

const answerSchema = z.object({
  description: z.string().trim().min(20).max(400),
  aliases: z.array(z.string().trim().min(1).max(120)).min(1).max(12),
});
type Answer = z.infer<typeof answerSchema>;
const answersFileSchema = z.record(z.string(), z.object({ promptVersion: z.string(), answer: answerSchema }));

const embeddingsSchema = z.object({ model: z.string(), documents: z.array(z.object({ title: z.string(), vector: z.string() })) });

export interface RefineOptions {
  dryRun: boolean;
  go: boolean;
  sample?: number;
  minCosine: number;
  /** Explicit targets instead of the cosine search; each is compared with the other listed topics. */
  topics?: string[];
}

/** Explicit targets (--topics), for topics without recorded vectors yet, such as newly added ones. */
function explicitTargets(topics: SeedTopic[], slugs: string[]): Target[] {
  const bySlug = new Map(topics.map((t) => [t.slug, t]));
  const unknown = slugs.filter((s) => !bySlug.has(s));
  if (unknown.length > 0) throw new Error(`--topics: unknown slugs ${unknown.join(', ')}`);
  const listed = slugs.flatMap((s) => bySlug.get(s) ?? []);
  return listed.map((topic) => ({ topic, neighbours: listed.filter((n) => n !== topic).slice(0, MAX_EXPLICIT_NEIGHBOURS).map((n) => ({ topic: n, cosine: NaN })) }));
}

interface Target {
  topic: SeedTopic;
  neighbours: { topic: SeedTopic; cosine: number }[];
}

function decode(encoded: string): Float32Array {
  const bytes = Buffer.from(encoded, 'base64');
  return new Float32Array(bytes.buffer, bytes.byteOffset, bytes.byteLength / 4);
}

/** Topics in a pair at or above minCosine, plus ALWAYS, each with its nearest neighbours. */
function findTargets(topics: SeedTopic[], minCosine: number): { targets: Target[]; pairs: number; model: string } {
  const recording = embeddingsSchema.parse(JSON.parse(readFileSync(EMBEDDINGS_FILE, 'utf8')));
  const byName = new Map(topics.map((t) => [t.canonicalName, t]));
  const vectors = recording.documents.flatMap((d) => {
    const topic = byName.get(d.title);
    if (!topic) return [];
    const v = decode(d.vector);
    return [{ topic, v, norm: Math.hypot(...v) }];
  });
  if (vectors.length !== topics.length) throw new Error(`Embeddings cover ${vectors.length} of ${topics.length} topics; re-record them first`);
  const cosine = (a: (typeof vectors)[number], b: (typeof vectors)[number]): number => {
    let dot = 0;
    for (let i = 0; i < a.v.length; i++) dot += (a.v[i] ?? 0) * (b.v[i] ?? 0);
    return dot / (a.norm * b.norm);
  };
  const near = new Map(vectors.map((a) => [a.topic.slug, vectors.filter((b) => b !== a).map((b) => ({ topic: b.topic, cosine: cosine(a, b) })).sort((x, y) => y.cosine - x.cosine)]));
  const chosen = new Set(ALWAYS);
  let pairs = 0;
  for (const [slug, list] of near) {
    for (const n of list) {
      if (n.cosine < minCosine) break;
      chosen.add(slug);
      if (slug < n.topic.slug) pairs++;
    }
  }
  const targets = topics.filter((t) => chosen.has(t.slug)).map((topic) => ({ topic, neighbours: (near.get(topic.slug) ?? []).slice(0, NEIGHBOURS) }));
  return { targets, pairs, model: recording.model };
}

function loadAnswers(): Map<string, Answer> {
  const answers = new Map<string, Answer>();
  if (!existsSync(ANSWERS_FILE)) return answers;
  for (const [slug, entry] of Object.entries(answersFileSchema.parse(JSON.parse(readFileSync(ANSWERS_FILE, 'utf8'))))) {
    if (entry.promptVersion === PROMPT.version) answers.set(slug, entry.answer);
  }
  return answers;
}

function saveAnswers(answers: Map<string, Answer>): void {
  const out: Record<string, { promptVersion: string; answer: Answer }> = {};
  for (const [slug, answer] of [...answers].sort(([a], [b]) => a.localeCompare(b))) out[slug] = { promptVersion: PROMPT.version, answer };
  writeJson(ANSWERS_FILE, out);
}

function entry(topic: SeedTopic): string {
  return `Name: ${topic.canonicalName}\nAlso known as: ${topic.aliases.join(', ') || 'none'}\nDescription: ${topic.description}`;
}

function userTurn(target: Target): string {
  const neighbours = target.neighbours.map((n) =>
    Number.isNaN(n.cosine) ? `<neighbour>\n${entry(n.topic)}\n</neighbour>` : `<neighbour similarity="${n.cosine.toFixed(3)}">\n${entry(n.topic)}\n</neighbour>`,
  );
  return `<topic>\n${entry(target.topic)}\n</topic>\n\n${neighbours.join('\n')}`;
}

function requestParams(target: Target): Anthropic.MessageCreateParamsNonStreaming {
  const apiSchema = z.object({ description: z.string(), aliases: z.array(z.string()) });
  return {
    model: SEED_MODEL,
    max_tokens: MAX_TOKENS,
    system: [{ type: 'text', text: PROMPT.text, cache_control: { type: 'ephemeral' } }],
    messages: [{ role: 'user', content: userTurn(target) }],
    output_config: { format: { type: 'json_schema', schema: toStructuredSchema(apiSchema) }, effort: 'medium' },
  };
}

function accept(answers: Map<string, Answer>, slug: string, message: Anthropic.Message): boolean {
  const json = replyJson(COMMAND, slug, message);
  if (json === undefined) return false;
  const parsed = answerSchema.safeParse(json);
  if (!parsed.success) {
    reject(COMMAND, slug, parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; '), json);
    return false;
  }
  answers.set(slug, parsed.data);
  return true;
}

export async function runRefine(options: RefineOptions): Promise<void> {
  const write = (line: string): boolean => process.stdout.write(`${line}\n`);
  const topics = parseSeed({ topics: readSeedFiles(SEED_DIR).topics, items: {} }).topics;
  const found = options.topics ? undefined : findTargets(topics, options.minCosine);
  const targets = found?.targets ?? explicitTargets(topics, options.topics ?? []);
  const bySlug = new Map(targets.map((t) => [t.topic.slug, t]));
  const answers = loadAnswers();

  const open = openRun(COMMAND);
  if (open) {
    if (options.dryRun) {
      write(`Batch ${open.batchId} (${open.requests} requests) is still open; a real run collects it at no extra cost.`);
      return;
    }
    await collect(new Anthropic(), bySlug, answers, open.batchId);
    assemble(topics, targets, answers);
    return;
  }

  const domains = ['software', 'stem', 'non_technical'].map((d) => `${d} ${targets.filter((t) => t.topic.domain === d).length}`);
  write(
    found
      ? `Near neighbours (${found.model} topic vectors, cosine >= ${options.minCosine}): ${found.pairs} pairs; ${targets.length} topics to refine incl. ${ALWAYS.join(', ')} (${domains.join(', ')}).`
      : `Explicit targets (--topics): ${targets.length} topics, each compared with the other listed topics (${domains.join(', ')}).`,
  );
  const pending = targets.filter((t) => !answers.has(t.topic.slug));
  write(`Refine: ${answers.size} answered (prompt ${PROMPT.name}/${PROMPT.version}), ${pending.length} pending.`);
  if (pending.length === 0) {
    if (!options.dryRun) assemble(topics, targets, answers);
    return;
  }

  const chosen = options.sample === undefined ? pending : pending.filter((t) => ALWAYS.includes(t.topic.slug)).concat(pending.filter((t) => !ALWAYS.includes(t.topic.slug))).slice(0, options.sample);
  const batch = options.sample === undefined;
  const est = estimate(
    chosen.length,
    { prefixTokens: estimateTokens(PROMPT.text) + 100, suffixTokens: Math.max(...chosen.map((t) => estimateTokens(userTurn(t)))), outputTokens: EXPECTED_OUTPUT_TOKENS },
    batch,
  );
  write(formatEstimate(batch ? 'seed:topics-refine' : `seed:topics-refine --sample ${chosen.length} (${chosen.map((t) => t.topic.slug).join(', ')})`, est, batch));
  if (options.dryRun) return;
  if (!options.go) {
    write('Not started: rerun with --go once the estimate is approved.');
    return;
  }
  assertWithinCap(est.usdNoCache);

  const client = new Anthropic();
  if (!batch) {
    await runSample(client, chosen, answers);
    return;
  }
  const requests = chosen.map((t) => ({ custom_id: t.topic.slug, params: requestParams(t) }));
  await collect(client, bySlug, answers, await submitBatch(client, COMMAND, PROMPT.version, requests));
  assemble(topics, targets, answers);
}

async function runSample(client: Anthropic, chosen: Target[], answers: Map<string, Answer>): Promise<void> {
  let usage: Usage = ZERO_USAGE;
  let accepted = 0;
  try {
    for (const target of chosen) {
      const message = await client.messages.create(requestParams(target), { timeout: 90_000, maxRetries: 2 });
      usage = addUsage(usage, fromApiUsage(message.usage));
      if (accept(answers, target.topic.slug, message)) accepted++;
    }
  } finally {
    saveAnswers(answers);
    const cost = logSpend({ command: `${COMMAND} --sample`, batch: false, requests: chosen.length, usage, ref: PROMPT.version });
    process.stdout.write(`Sample done: ${accepted}/${chosen.length} accepted, actual cost ${usd(cost)}. Answers wait in seed/_work/topics-refine.json.\n`);
  }
}

async function collect(client: Anthropic, bySlug: Map<string, Target>, answers: Map<string, Answer>, batchId: string): Promise<void> {
  try {
    await collectBatch(client, COMMAND, batchId, (slug, message) => {
      if (!bySlug.has(slug)) {
        reject(COMMAND, slug, 'not a refine target');
        return false;
      }
      return accept(answers, slug, message);
    });
  } finally {
    saveAnswers(answers);
  }
}

/**
 * Rewrites seed/topics.json once every target is answered: only the targets' description and aliases
 * change. A new alias is dropped when it repeats the topic's name or another alias, is another topic's
 * name, is another topic's alias that this topic didn't already share, or is an eval phrase it didn't
 * already have (golden exact cases such as k8s rely on existing aliases). Aliases that
 * two or more topics shared on purpose (such as "PM") are kept even if the answer left them out.
 */
function assemble(topics: SeedTopic[], targets: Target[], answers: Map<string, Answer>): void {
  const missing = targets.filter((t) => !answers.has(t.topic.slug)).map((t) => t.topic.slug);
  if (missing.length > 0) {
    process.stdout.write(`topics.json not changed: ${missing.length} targets still need an answer (${missing.join(', ')}). Rerun to retry them.\n`);
    return;
  }
  const targetSlugs = new Set(targets.map((t) => t.topic.slug));
  const evalPhrases = new Set(
    EVAL_FILES.filter((f) => existsSync(f)).flatMap((f) => z.object({ cases: z.array(z.object({ text: z.string() })) }).parse(JSON.parse(readFileSync(f, 'utf8'))).cases.map((c) => c.text.trim().toLowerCase())),
  );
  const holders = new Map<string, number>();
  for (const t of topics) for (const a of t.aliases) holders.set(a.toLowerCase(), (holders.get(a.toLowerCase()) ?? 0) + 1);
  const names = new Map(topics.map((t) => [t.canonicalName.toLowerCase(), t.slug]));
  const claimed = new Map<string, Set<string>>();
  const claim = (alias: string, slug: string): void => {
    const key = alias.toLowerCase();
    claimed.set(key, new Set([...(claimed.get(key) ?? []), slug]));
  };
  for (const t of topics) if (!targetSlugs.has(t.slug)) for (const a of t.aliases) claim(a, t.slug);

  let dropped = 0;
  const next = topics.map((t) => {
    const answer = answers.get(t.slug);
    if (!answer || !targetSlugs.has(t.slug)) return { ...t };
    const before = new Set(t.aliases.map((a) => a.toLowerCase()));
    const seen = new Set([t.canonicalName.toLowerCase()]);
    const aliases = answer.aliases.filter((alias) => {
      const key = alias.toLowerCase();
      const otherName = names.has(key) && names.get(key) !== t.slug;
      const otherAlias = [...(claimed.get(key) ?? [])].some((slug) => slug !== t.slug) && !before.has(key);
      const newEvalAlias = evalPhrases.has(key) && !before.has(key);
      const ok = !seen.has(key) && !otherName && !otherAlias && !newEvalAlias;
      seen.add(key);
      if (ok) claim(alias, t.slug);
      else dropped++;
      return ok;
    });
    const shared = t.aliases.filter((a) => (holders.get(a.toLowerCase()) ?? 0) > 1 && !seen.has(a.toLowerCase()));
    return { ...t, description: answer.description, aliases: [...shared, ...aliases].slice(0, MAX_ALIASES) };
  });
  const file = { version: 1, topics: next };
  parseSeed({ topics: file, items: readSeedFiles(SEED_DIR).items });
  writeJson(TOPICS_FILE, file);
  process.stdout.write(`Wrote seed/topics.json: ${targets.length} topics refined (description and aliases only), ${dropped} clashing or duplicate aliases dropped. Next: pnpm seed:validate --expect-topics 150\n`);
}
