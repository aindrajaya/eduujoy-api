import { existsSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import Anthropic from '@anthropic-ai/sdk';
import { z } from 'zod';
import { toStructuredSchema } from '../../src/shared/ai/json-schema';
import { collectBatch, replyJson, submitBatch } from './batch';
import { META_CONCEPTS, normaliseConcept, VAGUE_CONCEPTS } from './concept-stoplist';
import { assertWithinCap, logSpend, openRun, reject, ROOT, SEED_DIR, writeJson } from './ledger';
import { addUsage, estimate, estimateTokens, formatEstimate, fromApiUsage, SEED_MODEL, usd, ZERO_USAGE, type Usage } from './pricing';

// seed:concept-maps. Per topic and Dreyfus stage: 4-8 concepts in prerequisite order, their prerequisite
// edges and 2-3 misconceptions, in seed/concept-maps/<slug>.json (format v1, agreed with the lead and the
// API lane on 3 Nov 2026). One Batch request per topic covers all five stages; maps the code flags go to a
// Batch review. Isolation (user and lead, 3 Nov 2026): the generator's only inputs are seed/topics.json
// and its own two prompt files, read through readInput below; it never reads the eval set, the eval tools
// or their prompts. tools/seed/concept-maps.test.ts checks that.

/** The generator's inputs. readInput refuses anything else. */
export const ALLOWED_INPUTS = ['seed/topics.json', 'src/prompts/concept-map/v1.md', 'src/prompts/concept-map-review/v1.md'] as const;
/** Every input path read in this process, for the isolation test. */
export const inputReads = new Set<string>();

export function readInput(path: string): string {
  const rel = relative(ROOT, join(ROOT, path)).split('\\').join('/');
  if (!(ALLOWED_INPUTS as readonly string[]).includes(rel)) throw new Error(`concept-maps may not read ${rel}: inputs are limited to ${ALLOWED_INPUTS.join(', ')}`);
  inputReads.add(rel);
  return readFileSync(join(ROOT, rel), 'utf8');
}

const DRAFT_PROMPT = { name: 'concept-map', version: 'v1', file: 'src/prompts/concept-map/v1.md' } as const;
const REVIEW_PROMPT = { name: 'concept-map-review', version: 'v1', file: 'src/prompts/concept-map-review/v1.md' } as const;

const OUT_DIR = join(SEED_DIR, 'concept-maps');
const WORK_FILE = join(SEED_DIR, '_work', 'concept-maps.json');
const REJECTS_FILE = join(SEED_DIR, '_rejects', 'concept-maps.jsonl');
const COMMAND = 'concept-maps';

export const STAGES = ['novice', 'advanced_beginner', 'competent', 'proficient', 'expert'] as const;
type Stage = (typeof STAGES)[number];
const BLOOMS = ['C1', 'C2', 'C3', 'C4', 'C5', 'C6'] as const;
type Bloom = (typeof BLOOMS)[number];
/** The product's stage -> Bloom band (master PRD §5; the item bank's 10 cells and the diagnostic ladder). */
export const BAND: Record<Stage, readonly [Bloom, Bloom]> = {
  novice: ['C1', 'C2'],
  advanced_beginner: ['C2', 'C3'],
  competent: ['C3', 'C4'],
  proficient: ['C4', 'C5'],
  expert: ['C5', 'C6'],
};
const PREFIX: Record<Stage, string> = { novice: 'nov', advanced_beginner: 'adb', competent: 'cmp', proficient: 'prf', expert: 'exp' };

const topicSchema = z.object({ slug: z.string(), canonicalName: z.string(), description: z.string(), parent: z.string().nullable(), prerequisites: z.array(z.string()) });
type Topic = z.infer<typeof topicSchema>;

export function loadTopics(): Topic[] {
  const raw = z.object({ topics: z.array(z.unknown()) }).parse(JSON.parse(readInput('seed/topics.json')));
  return raw.topics.map((t) => topicSchema.parse(t));
}

const conceptSchema = z.object({
  id: z.string(),
  name: z.string().trim().min(2).max(80),
  aliases: z.array(z.string().trim().min(1).max(60)).max(4),
  bloom: z.enum(BLOOMS),
  summary: z.string().trim().min(10).max(300),
});
const stageSchema = z.object({
  stage: z.enum(STAGES),
  concepts: z.array(conceptSchema).min(4).max(8),
  prerequisites: z.array(z.tuple([z.string(), z.string()])).max(30),
  misconceptions: z.array(z.object({ text: z.string().trim().min(10).max(300), concepts: z.array(z.string()).min(1).max(4) })).min(2).max(3),
});
const mapSchema = z.object({ stages: z.array(stageSchema).length(5) });
export type ConceptMap = z.infer<typeof mapSchema>;

const apiMapSchema = z.object({
  stages: z.array(
    z.object({
      stage: z.enum(STAGES),
      concepts: z.array(z.object({ id: z.string(), name: z.string(), aliases: z.array(z.string()), bloom: z.enum(BLOOMS), summary: z.string() })),
      prerequisites: z.array(z.array(z.string())),
      misconceptions: z.array(z.object({ text: z.string(), concepts: z.array(z.string()) })),
    }),
  ),
});

/** Hard rules (a failure rejects the map): the agreed format and the lead's and API lane's checks. */
export function checkMap(topic: Topic, topics: Topic[], map: ConceptMap): string[] {
  const problems: string[] = [];
  const stageOf = new Map<string, number>();
  const names = new Map<string, string>();
  const banned = new Set([
    ...META_CONCEPTS.map(normaliseConcept),
    normaliseConcept(topic.canonicalName),
    ...topic.prerequisites.map((s) => normaliseConcept(topics.find((t) => t.slug === s)?.canonicalName ?? s)),
  ]);
  map.stages.forEach((s, i) => {
    if (s.stage !== STAGES[i]) problems.push(`stage ${i + 1} is ${s.stage}, expected ${STAGES[i]}`);
    const [lo, hi] = BAND[STAGES[i] ?? 'novice'];
    for (const c of s.concepts) {
      if (!new RegExp(`^${PREFIX[STAGES[i] ?? 'novice']}-\\d{1,2}$`).test(c.id)) problems.push(`${c.id}: id must be ${PREFIX[STAGES[i] ?? 'novice']}-<n>`);
      if (stageOf.has(c.id)) problems.push(`${c.id}: duplicate id`);
      stageOf.set(c.id, i);
      if (BLOOMS.indexOf(c.bloom) < BLOOMS.indexOf(lo) || BLOOMS.indexOf(c.bloom) > BLOOMS.indexOf(hi)) problems.push(`${c.id}: ${c.bloom} outside ${lo}-${hi}`);
      const key = normaliseConcept(c.name);
      if (banned.has(key)) problems.push(`${c.id}: "${c.name}" is a stop-listed, topic or prerequisite-topic name`);
      const seen = names.get(key);
      if (seen) problems.push(`${c.id}: name "${c.name}" repeats ${seen}`);
      names.set(key, c.id);
      const aliasKeys = c.aliases.map(normaliseConcept);
      if (new Set(aliasKeys).size !== aliasKeys.length || aliasKeys.includes(key)) problems.push(`${c.id}: duplicate alias or alias equal to the name`);
    }
  });
  const edges: [string, string][] = [];
  map.stages.forEach((s, i) => {
    for (const [a, b] of s.prerequisites) {
      const sa = stageOf.get(a);
      const sb = stageOf.get(b);
      if (sa === undefined || sb === undefined) problems.push(`prerequisite [${a}, ${b}] has an unknown id`);
      else if (a === b) problems.push(`prerequisite [${a}, ${b}] is a self-edge`);
      else if (sb !== i) problems.push(`prerequisite [${a}, ${b}] listed under ${s.stage} but ${b} is not a ${s.stage} concept`);
      else if (sa > sb) problems.push(`prerequisite [${a}, ${b}] points to a higher stage`);
      else edges.push([a, b]);
    }
    for (const m of s.misconceptions) for (const id of m.concepts) if (!stageOf.has(id)) problems.push(`misconception refers to unknown ${id}`);
  });
  if (hasCycle(edges)) problems.push('prerequisites contain a cycle');
  return problems;
}

function hasCycle(edges: [string, string][]): boolean {
  const out = new Map<string, string[]>();
  for (const [a, b] of edges) out.set(a, [...(out.get(a) ?? []), b]);
  const state = new Map<string, 1 | 2>();
  const visit = (n: string): boolean => {
    if (state.get(n) === 1) return true;
    if (state.get(n) === 2) return false;
    state.set(n, 1);
    for (const m of out.get(n) ?? []) if (visit(m)) return true;
    state.set(n, 2);
    return false;
  };
  return [...out.keys()].some((n) => visit(n));
}

/** Soft flags (the map goes to review): vague names, near-duplicates, thin structure. */
export function flagMap(map: ConceptMap): string[] {
  const flags: string[] = [];
  const vague = new Set(VAGUE_CONCEPTS.map(normaliseConcept));
  const all = map.stages.flatMap((s) => s.concepts);
  const words = (n: string): Set<string> => new Set(normaliseConcept(n).split(' ').filter((w) => w.length > 2));
  for (const c of all) if (vague.has(normaliseConcept(c.name)) || [...vague].some((v) => normaliseConcept(c.name).startsWith(`${v} `))) flags.push(`vague name: ${c.id} "${c.name}"`);
  for (let i = 0; i < all.length; i++) {
    for (let j = i + 1; j < all.length; j++) {
      const a = words(all[i]?.name ?? '');
      const b = words(all[j]?.name ?? '');
      const shared = [...a].filter((w) => b.has(w)).length;
      if (a.size > 0 && b.size > 0 && shared / (a.size + b.size - shared) >= 0.6) flags.push(`near-duplicate names: ${all[i]?.id} / ${all[j]?.id}`);
    }
  }
  for (const s of map.stages) {
    if (s.prerequisites.length === 0 && s.concepts.length >= 5) flags.push(`${s.stage}: no prerequisite edges`);
    for (const m of s.misconceptions) if (m.text.length < 30) flags.push(`${s.stage}: thin misconception "${m.text}"`);
  }
  const names = new Set(all.map((c) => normaliseConcept(c.name)));
  for (const c of all) for (const a of c.aliases) if (names.has(normaliseConcept(a))) flags.push(`${c.id}: alias "${a}" is another concept's name`);
  return flags;
}

/** Concepts of one stage in prerequisite order (stable: original order among independent concepts). */
export function inPrerequisiteOrder(stage: ConceptMap['stages'][number]): ConceptMap['stages'][number]['concepts'] {
  const ids = new Set(stage.concepts.map((c) => c.id));
  const inStage = stage.prerequisites.filter(([a, b]) => ids.has(a) && ids.has(b));
  const placed: typeof stage.concepts = [];
  const left = [...stage.concepts];
  while (left.length > 0) {
    const index = left.findIndex((c) => !inStage.some(([a, b]) => b === c.id && left.some((l) => l.id === a)));
    const [next] = left.splice(index < 0 ? 0 : index, 1);
    if (next) placed.push(next);
  }
  return placed;
}

// ---------- requests ----------

function topicBlock(topic: Topic, topics: Topic[]): string {
  const name = (slug: string): string => topics.find((t) => t.slug === slug)?.canonicalName ?? slug;
  return [
    `Name: ${topic.canonicalName}`,
    `Description: ${topic.description}`,
    `Part of: ${topic.parent ? name(topic.parent) : 'none'}`,
    `Prerequisite topics (assumed known): ${topic.prerequisites.map(name).join(', ') || 'none'}`,
  ].join('\n');
}

const workSchema = z.object({
  batches: z.array(z.string()),
  maps: z.record(
    z.string(),
    z.object({
      draft: z.object({ promptVersion: z.string(), value: mapSchema }).optional(),
      review: z.object({ promptVersion: z.string(), verdict: z.enum(['keep', 'revise']), issues: z.array(z.string()), revised: mapSchema.nullable() }).optional(),
    }),
  ),
});
type Work = z.infer<typeof workSchema>;

function loadWork(): Work {
  return existsSync(WORK_FILE) ? workSchema.parse(JSON.parse(readFileSync(WORK_FILE, 'utf8'))) : { batches: [], maps: {} };
}

/** The rule this topic's last rejected draft or revision broke, for the retry request. */
function lastProblem(slug: string, label: 'draft' | 'revision'): string | undefined {
  if (!existsSync(REJECTS_FILE)) return undefined;
  const rows = readFileSync(REJECTS_FILE, 'utf8').trim().split('\n').filter(Boolean);
  return rows.map((l) => z.object({ id: z.string(), reason: z.string() }).parse(JSON.parse(l))).filter((r) => r.id === `${slug} ${label}`).at(-1)?.reason;
}

export function draftRequest(topic: Topic, topics: Topic[], prompt: string): Anthropic.MessageCreateParamsNonStreaming {
  const problem = lastProblem(topic.slug, 'draft');
  const retry = problem ? `\n<previous_attempt>\nA previous map for this topic broke a rule: ${problem}. Fix that.\n</previous_attempt>` : '';
  return request(prompt, `<topic>\n${topicBlock(topic, topics)}\n</topic>${retry}`, apiMapSchema);
}

function reviewRequest(topic: Topic, topics: Topic[], prompt: string, map: ConceptMap, flags: string[]): Anthropic.MessageCreateParamsNonStreaming {
  const problem = lastProblem(topic.slug, 'revision');
  const retry = problem ? `\n<previous_attempt>\nA previous revision broke a rule: ${problem}. Fix that.\n</previous_attempt>` : '';
  const schema = z.object({ verdict: z.enum(['keep', 'revise']), issues: z.array(z.string()), revised: apiMapSchema.nullable() });
  return request(prompt, `<topic>\n${topicBlock(topic, topics)}\n</topic>\nFlags: ${flags.join('; ')}\n<map>\n${JSON.stringify(map)}\n</map>${retry}`, schema);
}

function request(system: string, user: string, schema: z.ZodType): Anthropic.MessageCreateParamsNonStreaming {
  return {
    model: SEED_MODEL,
    max_tokens: 16_000,
    system: [{ type: 'text', text: system, cache_control: { type: 'ephemeral' } }],
    messages: [{ role: 'user', content: user }],
    output_config: { format: { type: 'json_schema', schema: toStructuredSchema(schema) }, effort: 'medium' },
  };
}

function parseMap(topic: Topic, topics: Topic[], json: unknown, label: 'draft' | 'revision'): ConceptMap | undefined {
  const parsed = mapSchema.safeParse(json);
  if (!parsed.success) {
    reject(COMMAND, `${topic.slug} ${label}`, parsed.error.issues.slice(0, 6).map((i) => `${i.path.join('.')}: ${i.message}`).join('; '), json);
    return undefined;
  }
  const problems = checkMap(topic, topics, parsed.data);
  if (problems.length > 0) {
    reject(COMMAND, `${topic.slug} ${label}`, problems.slice(0, 8).join('; '), json);
    return undefined;
  }
  return parsed.data;
}

// ---------- run ----------

export interface ConceptMapOptions {
  stage: 'draft' | 'review' | 'assemble';
  dryRun: boolean;
  go: boolean;
  sample?: number;
  expectTopics?: number;
}

export async function runConceptMaps(o: ConceptMapOptions): Promise<void> {
  const write = (line: string): boolean => process.stdout.write(`${line}\n`);
  const topics = loadTopics();
  const work = loadWork();
  if (o.stage === 'assemble') {
    assemble(topics, work, o.expectTopics, write);
    return;
  }
  const draftPrompt = readInput(DRAFT_PROMPT.file);
  const reviewPrompt = readInput(REVIEW_PROMPT.file);
  const command = `${COMMAND}-${o.stage}`;
  const bySlug = new Map(topics.map((t) => [t.slug, t]));

  const flagged = (slug: string): string[] => {
    const draft = work.maps[slug]?.draft?.value;
    return draft ? flagMap(draft) : [];
  };
  const pending =
    o.stage === 'draft'
      ? topics.filter((t) => work.maps[t.slug]?.draft?.promptVersion !== DRAFT_PROMPT.version)
      : topics.filter((t) => work.maps[t.slug]?.draft && flagged(t.slug).length > 0 && work.maps[t.slug]?.review?.promptVersion !== REVIEW_PROMPT.version);
  const drafted = topics.filter((t) => work.maps[t.slug]?.draft).length;
  const flaggedCount = topics.filter((t) => flagged(t.slug).length > 0).length;
  write(`concept-maps ${o.stage}: ${topics.length} topics, ${drafted} drafted, ${flaggedCount} flagged for review, ${pending.length} pending for this stage.`);

  const open = openRun(command);
  if (open) {
    if (o.dryRun) {
      write(`Batch ${open.batchId} is still open; a real run collects it at no extra cost.`);
      return;
    }
    await collect(new Anthropic(), command, open.batchId, work, bySlug, topics, o.stage);
    return;
  }
  if (pending.length === 0) return;

  const targets = o.sample === undefined ? pending : pending.slice(0, o.sample);
  const batch = o.sample === undefined;
  const build = (t: Topic): Anthropic.MessageCreateParamsNonStreaming => {
    const draft = work.maps[t.slug]?.draft?.value;
    return o.stage === 'draft' || !draft ? draftRequest(t, topics, draftPrompt) : reviewRequest(t, topics, reviewPrompt, draft, flagged(t.slug));
  };
  const prompt = o.stage === 'draft' ? draftPrompt : reviewPrompt;
  const suffix = Math.max(...targets.map((t) => estimateTokens(JSON.stringify(build(t).messages))));
  const est = estimate(targets.length, { prefixTokens: estimateTokens(prompt) + 500, suffixTokens: suffix, outputTokens: o.stage === 'draft' ? 6_000 : 7_000 }, batch);
  write(formatEstimate(`seed:concept-maps --stage ${o.stage}${batch ? '' : ` --sample ${targets.length}`}`, est, batch));
  if (o.dryRun) return;
  if (!o.go) {
    write('Not started: rerun with --go once the estimate is approved.');
    return;
  }
  assertWithinCap(est.usdNoCache);

  const client = new Anthropic();
  if (batch) {
    const version = o.stage === 'draft' ? DRAFT_PROMPT.version : REVIEW_PROMPT.version;
    const id = await submitBatch(client, command, version, targets.map((t) => ({ custom_id: t.slug, params: build(t) })));
    work.batches.push(id);
    writeJson(WORK_FILE, work);
    await collect(client, command, id, work, bySlug, topics, o.stage);
    return;
  }
  let usage: Usage = ZERO_USAGE;
  let accepted = 0;
  try {
    for (const t of targets) {
      const message = await client.messages.stream(build(t), { maxRetries: 0 }).finalMessage();
      usage = addUsage(usage, fromApiUsage(message.usage));
      if (accept(work, t, topics, message, o.stage)) accepted++;
    }
  } finally {
    writeJson(WORK_FILE, work);
    const cost = logSpend({ command: `${command} --sample`, batch: false, requests: targets.length, usage, ref: o.stage === 'draft' ? DRAFT_PROMPT.version : REVIEW_PROMPT.version });
    write(`Sample done: ${accepted}/${targets.length} accepted, actual cost ${usd(cost)}.`);
  }
}

function accept(work: Work, topic: Topic, topics: Topic[], message: Anthropic.Message, stage: 'draft' | 'review'): boolean {
  const json = replyJson(COMMAND, `${topic.slug} ${stage}`, message);
  if (json === undefined) return false;
  const entry = (work.maps[topic.slug] ??= {});
  if (stage === 'draft') {
    const map = parseMap(topic, topics, json, 'draft');
    if (!map) return false;
    entry.draft = { promptVersion: DRAFT_PROMPT.version, value: map };
    delete entry.review;
    return true;
  }
  const raw = z.object({ verdict: z.enum(['keep', 'revise']), issues: z.array(z.string()), revised: z.unknown() }).safeParse(json);
  if (!raw.success) {
    reject(COMMAND, `${topic.slug} review`, 'malformed review', json);
    return false;
  }
  const revised = raw.data.verdict === 'revise' ? parseMap(topic, topics, raw.data.revised, 'revision') : null;
  if (raw.data.verdict === 'revise' && !revised) return false;
  entry.review = { promptVersion: REVIEW_PROMPT.version, verdict: raw.data.verdict, issues: raw.data.issues, revised: revised ?? null };
  return true;
}

async function collect(client: Anthropic, command: string, batchId: string, work: Work, bySlug: Map<string, Topic>, topics: Topic[], stage: 'draft' | 'review'): Promise<void> {
  if (!work.batches.includes(batchId)) work.batches.push(batchId);
  try {
    await collectBatch(client, command, batchId, (slug, message) => {
      const topic = bySlug.get(slug);
      if (!topic) {
        reject(COMMAND, slug, 'unknown topic');
        return false;
      }
      return accept(work, topic, topics, message, stage);
    });
  } finally {
    writeJson(WORK_FILE, work);
  }
}

// ---------- assemble and check (free) ----------

function finalMap(work: Work, slug: string): ConceptMap | undefined {
  const entry = work.maps[slug];
  if (!entry?.draft) return undefined;
  if (flagMap(entry.draft.value).length > 0) {
    if (entry.review?.promptVersion !== REVIEW_PROMPT.version) return undefined;
    return entry.review.verdict === 'revise' && entry.review.revised ? entry.review.revised : entry.draft.value;
  }
  return entry.draft.value;
}

function assemble(topics: Topic[], work: Work, expectTopics: number | undefined, write: (line: string) => boolean): void {
  const missing = topics.filter((t) => !finalMap(work, t.slug)).map((t) => t.slug);
  if (missing.length > 0) {
    write(`Not written: ${missing.length} topics lack a draft or a needed review (${missing.join(', ')}).`);
    return;
  }
  for (const topic of topics) {
    const map = finalMap(work, topic.slug) as ConceptMap;
    const problems = checkMap(topic, topics, map);
    if (problems.length > 0) throw new Error(`${topic.slug}: ${problems.join('; ')}`);
    writeJson(join(OUT_DIR, `${topic.slug}.json`), {
      version: 1,
      topic: topic.slug,
      language: 'en',
      promptVersion: DRAFT_PROMPT.version,
      reviewed: work.maps[topic.slug]?.review?.promptVersion === REVIEW_PROMPT.version,
      dependsOnTopics: topic.prerequisites,
      stages: map.stages.map((s) => ({
        stage: s.stage,
        bloomBand: BAND[s.stage],
        concepts: inPrerequisiteOrder(s),
        prerequisites: s.prerequisites,
        misconceptions: s.misconceptions,
      })),
    });
  }
  const reviews = Object.values(work.maps).flatMap((m) => (m.review ? [m.review.verdict] : []));
  writeJson(join(OUT_DIR, '_provenance.json'), {
    version: 1,
    generatedAt: new Date().toISOString(),
    model: SEED_MODEL,
    prompts: [DRAFT_PROMPT, REVIEW_PROMPT].map(({ name, version, file }) => ({ name, version, file })),
    inputs: {
      files: [...ALLOWED_INPUTS],
      fieldsSentPerTopic: ['topics.json canonicalName', 'topics.json description', 'canonicalName of topics.json parent', 'canonicalName of each topics.json prerequisite'],
      codeFilled: ['bloomBand (stage -> band constant)', 'dependsOnTopics (topics.json prerequisites)', 'language "en"', 'concept order (prerequisite order, computed)'],
    },
    isolation:
      'seed/_eval and tools/seed/path-eval* were not read, nor their prompts or outputs. The generator reads inputs only through readInput (allow-list above); tools/seed/concept-maps.test.ts checks it. ' +
      'Note (lead, 3 Nov 2026): the topic description is also what the eval drafter saw; accepted as public catalogue text, nothing else added.',
    batches: work.batches,
    reviewMix: { keep: reviews.filter((v) => v === 'keep').length, revise: reviews.filter((v) => v === 'revise').length },
  });
  const files = topics.length;
  if (expectTopics !== undefined && files !== expectTopics) throw new Error(`expected ${expectTopics} topics, wrote ${files}`);
  write(`Wrote ${files} concept maps to seed/concept-maps/ plus _provenance.json; every map passed checkMap.`);
}

/** The file check for seed/concept-maps (no API calls). */
export function validateConceptMaps(expectTopics?: number): void {
  const topics = loadTopics();
  const fileSchema = z.object({
    version: z.literal(1),
    topic: z.string(),
    language: z.literal('en'),
    promptVersion: z.string(),
    reviewed: z.boolean(),
    dependsOnTopics: z.array(z.string()),
    stages: z.array(stageSchema.extend({ bloomBand: z.tuple([z.enum(BLOOMS), z.enum(BLOOMS)]) })).length(5),
  });
  const problems: string[] = [];
  let n = 0;
  for (const topic of topics) {
    const path = join(OUT_DIR, `${topic.slug}.json`);
    if (!existsSync(path)) {
      problems.push(`${topic.slug}: missing`);
      continue;
    }
    const parsed = fileSchema.safeParse(JSON.parse(readFileSync(path, 'utf8')));
    if (!parsed.success) {
      problems.push(`${topic.slug}: ${parsed.error.issues.slice(0, 3).map((i) => `${i.path.join('.')}: ${i.message}`).join('; ')}`);
      continue;
    }
    const f = parsed.data;
    if (f.topic !== topic.slug) problems.push(`${topic.slug}: topic field is ${f.topic}`);
    if (JSON.stringify(f.dependsOnTopics) !== JSON.stringify(topic.prerequisites)) problems.push(`${topic.slug}: dependsOnTopics differs from topics.json`);
    f.stages.forEach((s) => {
      if (JSON.stringify(s.bloomBand) !== JSON.stringify(BAND[s.stage])) problems.push(`${topic.slug} ${s.stage}: bloomBand mismatch`);
    });
    for (const p of checkMap(topic, topics, { stages: f.stages })) problems.push(`${topic.slug}: ${p}`);
    n++;
  }
  if (expectTopics !== undefined && n !== expectTopics) problems.push(`expected ${expectTopics} topics, found ${n}`);
  if (problems.length > 0) throw new Error(`seed/concept-maps is invalid:\n- ${problems.slice(0, 30).join('\n- ')}`);
  process.stdout.write(`Valid concept maps v1: ${n} topics x 5 stages\n`);
}
