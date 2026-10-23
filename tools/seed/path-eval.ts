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

// seed:path-eval (docs/prompts/03-path-eval-set.md). The A9 path-eval golden set in the format agreed with the
// API lane (docs/plans/A9-pathing.md, "Eval case format"): 90 cases, 30 of them the smoke subset.
//   plan     (free)  seed/_eval/path-eval-plan.json: topic, placement, hours, formats, smoke, from the pregen topics
//   draft    (paid)  Sonnet writes each case's goal and reference
//   review   (paid)  Sonnet keeps, revises or drops each draft
//   assemble (free)  seed/_eval/path-eval-v1.json from the plan, drafts and reviews, then the file check
// startBloomMax and endBloom come from the rules in code.

const PLAN_FILE = join(SEED_DIR, '_eval', 'path-eval-plan.json');
const OUT_FILE = join(SEED_DIR, '_eval', 'path-eval-v1.json');
const WORK_FILE = join(SEED_DIR, '_work', 'path-eval.json');
const PROMPTS = new PromptRegistry(join(ROOT, 'src', 'prompts'));
const DRAFT_PROMPT = PROMPTS.get('path-eval-draft', 'v1');
const REVIEW_PROMPT = PROMPTS.get('path-eval-review', 'v1');

const STAGES = ['novice', 'advanced_beginner', 'competent', 'proficient', 'expert'] as const;
type Stage = (typeof STAGES)[number];
const BLOOMS = ['C1', 'C2', 'C3', 'C4', 'C5', 'C6'] as const;
type Bloom = (typeof BLOOMS)[number];
const BAND: Record<Stage, [Bloom, Bloom]> = {
  novice: ['C1', 'C2'],
  advanced_beginner: ['C2', 'C3'],
  competent: ['C3', 'C4'],
  proficient: ['C4', 'C5'],
  expert: ['C5', 'C6'],
};
/** Agreed with the API lane, 23 Oct 2026; novice ending at C2 (a novice-band path) confirmed by the user (master PRD §5). */
const END_BLOOM: Record<Stage, Bloom> = { novice: 'C2', advanced_beginner: 'C4', competent: 'C5', proficient: 'C6', expert: 'C6' };
const FORMATS = ['video', 'text', 'papers'] as const;
const URL_LIKE = /https?:\/\/|www\.|\.(com|org|io|dev|net)\b/i;

const bloomIndex = (b: Bloom): number => BLOOMS.indexOf(b);
export function startBloomMax(stage: Stage, bloom: Bloom): Bloom {
  return BLOOMS[Math.min(bloomIndex(bloom) + 1, bloomIndex(END_BLOOM[stage]))] ?? END_BLOOM[stage];
}

const planCaseSchema = z.object({
  id: z.string().regex(/^pe-\d{3}$/),
  topic: z.string(),
  domain: z.enum(['software', 'stem', 'non_technical']),
  placement: z.object({ stage: z.enum(STAGES), bloom: z.enum(BLOOMS) }),
  weeklyHours: z.number().int().min(1).max(40),
  formats: z.array(z.enum(FORMATS)).max(3),
  smoke: z.boolean(),
});
type PlanCase = z.infer<typeof planCaseSchema>;
const planSchema = z.object({ version: z.literal(1), source: z.string(), cases: z.array(planCaseSchema) });

const sopStep = z.object({ objective: z.string().trim().min(5).max(300), bloom: z.enum(BLOOMS), concepts: z.array(z.string().trim().min(1).max(80)).min(1).max(8) });
const draftSchema = z.object({
  goal: z.string().trim().min(3).max(500),
  steps: z.object({ min: z.number().int(), max: z.number().int() }),
  mustCover: z.array(z.string().trim().min(2).max(80)).min(4).max(8),
  orderConstraints: z.array(z.tuple([z.string(), z.string()])).min(2).max(5),
  misconceptionsToAvoid: z.array(z.string().trim().min(5).max(300)).min(1).max(3),
  notes: z.string().trim().min(10).max(800),
  sop: z.array(sopStep).min(6).max(12),
});
type Draft = z.infer<typeof draftSchema>;

const reviewSchema = z.object({ verdict: z.enum(['keep', 'revise', 'drop']), issues: z.array(z.string()), revised: draftSchema.nullable() });

const workSchema = z.record(
  z.string(),
  z.object({
    draft: z.object({ promptVersion: z.string(), value: draftSchema }).optional(),
    review: z.object({ promptVersion: z.string(), value: reviewSchema }).optional(),
  }),
);
type Work = z.infer<typeof workSchema>;

/** Rule checks shared by drafts, revisions and the final file; returns the problems found. */
export function checkReference(c: Pick<PlanCase, 'placement' | 'weeklyHours'>, d: Draft): string[] {
  const problems: string[] = [];
  const end = END_BLOOM[c.placement.stage];
  const start = startBloomMax(c.placement.stage, c.placement.bloom);
  if (!(d.steps.min >= 6 && d.steps.min <= d.steps.max && d.steps.max <= 12)) problems.push(`steps ${d.steps.min}-${d.steps.max} outside 6-12`);
  if (d.sop.length < d.steps.min || d.sop.length > d.steps.max) problems.push(`sop has ${d.sop.length} steps, outside ${d.steps.min}-${d.steps.max}`);
  const blooms = d.sop.map((s) => bloomIndex(s.bloom));
  if ((blooms[0] ?? 99) > bloomIndex(start)) problems.push(`first step ${d.sop[0]?.bloom} above startBloomMax ${start}`);
  if (d.sop.at(-1)?.bloom !== end) problems.push(`last step ${d.sop.at(-1)?.bloom ?? '-'} is not endBloom ${end}`);
  if (blooms.some((b, i) => i > 0 && b < (blooms[i - 1] ?? 0))) problems.push('sop Bloom goes down');
  if (c.placement.stage === 'novice' && blooms.some((b) => b > bloomIndex('C2'))) problems.push('novice sop leaves C1-C2');
  const must = new Set(d.mustCover);
  if (must.size !== d.mustCover.length) problems.push('duplicate mustCover');
  const firstAt = (concept: string): number => d.sop.findIndex((s) => s.concepts.includes(concept));
  for (const m of d.mustCover) if (firstAt(m) < 0) problems.push(`mustCover "${m}" not in any sop step`);
  for (const [a, b] of d.orderConstraints) {
    if (!must.has(a) || !must.has(b)) problems.push(`orderConstraint [${a}, ${b}] uses a non-mustCover string`);
    else if (firstAt(a) > firstAt(b)) problems.push(`sop covers "${b}" before "${a}"`);
  }
  if (URL_LIKE.test(JSON.stringify(d))) problems.push('mentions a URL or domain');
  return problems;
}

// ---------- plan (free) ----------

/**
 * Builds the 90 inputs: about 40 software, 25 STEM and 25 non-technical cases from the pregen topics, most
 * at novice and advanced_beginner, 10 at competent and above (fixed below), hours across 1-2 / 3-5 / 6+,
 * formats mixed, and 30 smoke cases spread like the full set. Deterministic: same input, same plan.
 */
export function buildPlan(topics: SeedTopic[], pregen: string[], source: string): z.infer<typeof planSchema> {
  const domainOf = new Map(topics.map((t) => [t.slug, t.domain]));
  const advanced: [string, Stage, Bloom, boolean][] = [
    ['system-design', 'competent', 'C3', true],
    ['sql', 'proficient', 'C4', true],
    ['kubernetes', 'competent', 'C4', false],
    ['algorithms', 'competent', 'C3', false],
    ['machine-learning', 'competent', 'C3', true],
    ['statistics', 'competent', 'C4', false],
    ['linear-algebra', 'proficient', 'C5', false],
    ['product-management', 'competent', 'C3', true],
    ['negotiation', 'proficient', 'C4', false],
    ['leadership', 'expert', 'C5', false],
  ];
  // Cases per domain at novice/advanced_beginner, and how many of those go in the smoke subset.
  const quota = { software: { total: 36, smoke: 11 }, stem: { total: 22, smoke: 8 }, non_technical: { total: 22, smoke: 7 } } as const;
  const hours = [1, 4, 8, 2, 3, 6, 5, 10, 2, 4, 12, 1, 3, 6, 5];
  const formatSets: (typeof FORMATS)[number][][] = [[], ['video'], ['text'], ['video', 'text'], ['text', 'papers'], ['video', 'text', 'papers']];

  type Draftless = Omit<PlanCase, 'id'>;
  const rows: Draftless[] = [];
  let n = 0;
  const next = (): number => n++;
  for (const domain of ['software', 'stem', 'non_technical'] as const) {
    const list = pregen.filter((s) => domainOf.get(s) === domain);
    const { total, smoke } = quota[domain];
    // Two cases (novice + advanced_beginner) for the first topics, one (advanced_beginner) for the rest.
    const doubles = total - list.length;
    const slots: { topic: string; stage: Stage }[] = [];
    list.forEach((topic, i) => {
      if (i < doubles) slots.push({ topic, stage: 'novice' });
      slots.push({ topic, stage: 'advanced_beginner' });
    });
    const domainRows = slots.map((slot, i) => {
      const k = next();
      const bloom: Bloom = slot.stage === 'novice' ? (k % 7 < 3 ? 'C1' : 'C2') : k % 12 < 5 ? 'C2' : 'C3';
      const formats = formatSets[slot.stage === 'novice' ? k % 4 : k % formatSets.length] ?? [];
      return { topic: slot.topic, domain, placement: { stage: slot.stage, bloom }, weeklyHours: hours[k % hours.length] ?? 3, formats, smoke: i % Math.round(total / smoke) === 0 };
    });
    // Exactly `smoke` per domain: trim or top up in order.
    let picked = domainRows.filter((r) => r.smoke).length;
    for (const r of [...domainRows].reverse()) {
      if (picked > smoke && r.smoke) {
        r.smoke = false;
        picked--;
      }
    }
    for (const r of domainRows) {
      if (picked < smoke && !r.smoke) {
        r.smoke = true;
        picked++;
      }
    }
    rows.push(...domainRows);
  }
  for (const [topic, stage, bloom, smoke] of advanced) {
    const k = next();
    const domain = domainOf.get(topic);
    if (!domain || !pregen.includes(topic)) throw new Error(`advanced case topic ${topic} is not a pregen seed topic`);
    rows.push({ topic, domain, placement: { stage, bloom }, weeklyHours: [5, 6, 8, 4, 10][k % 5] ?? 6, formats: formatSets[3 + (k % 3)] ?? [], smoke });
  }
  // Smoke cases first (pe-001..pe-030), then the rest, each group by domain as built.
  const ordered = [...rows.filter((r) => r.smoke), ...rows.filter((r) => !r.smoke)];
  return { version: 1, source, cases: ordered.map((r, i) => ({ id: `pe-${String(i + 1).padStart(3, '0')}`, ...r })) };
}

// ---------- shared ----------

function loadPlan(): PlanCase[] {
  if (!existsSync(PLAN_FILE)) throw new Error('No plan yet: run seed:path-eval --stage plan --pregen <pregen-topics.json>');
  return planSchema.parse(JSON.parse(readFileSync(PLAN_FILE, 'utf8'))).cases;
}

function loadWork(): Work {
  return existsSync(WORK_FILE) ? workSchema.parse(JSON.parse(readFileSync(WORK_FILE, 'utf8'))) : {};
}

function topicBlock(topics: SeedTopic[], slug: string): string {
  const t = topics.find((x) => x.slug === slug);
  if (!t) throw new Error(`unknown topic ${slug}`);
  const name = (s: string): string => topics.find((x) => x.slug === s)?.canonicalName ?? s;
  return [
    `Name: ${t.canonicalName}`,
    `Description: ${t.description}`,
    `Part of: ${t.parent ? name(t.parent) : 'none'}`,
    `Prerequisites (the learner may or may not know them): ${t.prerequisites.map(name).join(', ') || 'none'}`,
  ].join('\n');
}

function caseBlock(c: PlanCase): string {
  return [
    `Placement: ${c.placement.stage} ${c.placement.bloom}`,
    `startBloomMax: ${startBloomMax(c.placement.stage, c.placement.bloom)}`,
    `endBloom: ${END_BLOOM[c.placement.stage]}`,
    `weeklyHours: ${c.weeklyHours} (total path time at most ${c.weeklyHours * 2} hours)`,
    `formats: ${c.formats.length > 0 ? c.formats.join(', ') : 'no preference'}`,
  ].join('\n');
}

const apiDraftSchema = z.object({
  goal: z.string(),
  steps: z.object({ min: z.number(), max: z.number() }),
  mustCover: z.array(z.string()),
  orderConstraints: z.array(z.array(z.string())),
  misconceptionsToAvoid: z.array(z.string()),
  notes: z.string(),
  sop: z.array(z.object({ objective: z.string(), bloom: z.enum(BLOOMS), concepts: z.array(z.string()) })),
});

function params(system: string, user: string, schema: z.ZodType): Anthropic.MessageCreateParamsNonStreaming {
  return {
    model: SEED_MODEL,
    max_tokens: 16_000,
    system: [{ type: 'text', text: system, cache_control: { type: 'ephemeral' } }],
    messages: [{ role: 'user', content: user }],
    output_config: { format: { type: 'json_schema', schema: toStructuredSchema(schema) }, effort: 'medium' },
  };
}

const REJECTS_FILE = join(SEED_DIR, '_rejects', 'path-eval.jsonl');

/** The rule a case's last rejected draft or revision broke, so a retry can fix it instead of repeating it. */
function lastProblem(id: string, label: 'draft' | 'revision'): string | undefined {
  if (!existsSync(REJECTS_FILE)) return undefined;
  const rows = readFileSync(REJECTS_FILE, 'utf8').trim().split('\n').filter(Boolean);
  const mine = rows.map((l) => z.object({ id: z.string(), reason: z.string() }).parse(JSON.parse(l))).filter((r) => r.id === `${id} ${label}`);
  return mine.at(-1)?.reason;
}

function draftParams(topics: SeedTopic[], c: PlanCase): Anthropic.MessageCreateParamsNonStreaming {
  const problem = lastProblem(c.id, 'draft');
  const retry = problem
    ? `\n<previous_attempt>\nA previous draft for this case broke a rule: ${problem}. Every step's Bloom level must be equal to or higher than the step before it; introduce a new concept at the current level instead of dropping back.\n</previous_attempt>`
    : '';
  return params(DRAFT_PROMPT.text, `<topic>\n${topicBlock(topics, c.topic)}\n</topic>\n<case>\n${caseBlock(c)}\n</case>${retry}`, apiDraftSchema);
}

const LIMITS = 'Limits for a revision: steps min 6 to max 12; mustCover 4-8; orderConstraints 2-5; misconceptionsToAvoid 1-3; sop length within steps.';

function reviewParams(topics: SeedTopic[], c: PlanCase, d: Draft): Anthropic.MessageCreateParamsNonStreaming {
  const problem = lastProblem(c.id, 'revision');
  const retry = problem ? `\n<previous_attempt>\nA previous revision of this case broke a rule: ${problem}. ${LIMITS} Merge or cut items to stay within them.\n</previous_attempt>` : '';
  const apiReview = z.object({ verdict: z.enum(['keep', 'revise', 'drop']), issues: z.array(z.string()), revised: apiDraftSchema.nullable() });
  return params(REVIEW_PROMPT.text, `<topic>\n${topicBlock(topics, c.topic)}\n</topic>\n<case>\n${caseBlock(c)}\n</case>\n<reference>\n${JSON.stringify(d, null, 2)}\n</reference>${retry}`, apiReview);
}

/** Parses and rule-checks a draft or revision; problems go to seed/_rejects/path-eval.jsonl. */
function acceptDraft(c: PlanCase, json: unknown, label: string): Draft | undefined {
  const parsed = draftSchema.safeParse(json);
  if (!parsed.success) {
    reject('path-eval', `${c.id} ${label}`, parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; '), json);
    return undefined;
  }
  const problems = checkReference(c, parsed.data);
  if (problems.length > 0) {
    reject('path-eval', `${c.id} ${label}`, problems.join('; '), json);
    return undefined;
  }
  return parsed.data;
}

// ---------- paid stages ----------

export interface PathEvalOptions {
  stage: 'plan' | 'draft' | 'review' | 'assemble';
  dryRun: boolean;
  go: boolean;
  sample?: number;
  only: 'smoke' | 'rest' | 'all';
  pregen?: string;
  expectCases?: number;
}

export async function runPathEval(o: PathEvalOptions): Promise<void> {
  const write = (line: string): boolean => process.stdout.write(`${line}\n`);
  const topics = parseSeed({ topics: readSeedFiles(SEED_DIR).topics, items: {} }).topics;

  if (o.stage === 'plan') {
    if (!o.pregen) throw new Error('--pregen <path to pregen-topics.json> is required');
    if (existsSync(PLAN_FILE)) throw new Error('seed/_eval/path-eval-plan.json exists; delete it on purpose to rebuild');
    const pregen = z.object({ topics: z.array(z.string()) }).parse(JSON.parse(readFileSync(o.pregen, 'utf8'))).topics;
    const plan = buildPlan(topics, pregen, 'scripts/discovery/pregen-topics.json on feat/pregen-script (23 Oct 2026)');
    if (!o.dryRun) writeJson(PLAN_FILE, plan);
    summarisePlan(plan.cases, write);
    return;
  }

  const plan = loadPlan();
  if (o.stage === 'assemble') {
    assemble(plan, loadWork(), o, write);
    return;
  }

  const scope = plan.filter((c) => o.only === 'all' || (o.only === 'smoke') === c.smoke);
  const work = loadWork();
  const command = `path-eval-${o.stage}`;
  const pending =
    o.stage === 'draft'
      ? scope.filter((c) => work[c.id]?.draft?.promptVersion !== DRAFT_PROMPT.version)
      : scope.filter((c) => work[c.id]?.draft && work[c.id]?.review?.promptVersion !== REVIEW_PROMPT.version);
  const waiting = o.stage === 'review' ? scope.filter((c) => !work[c.id]?.draft).length : 0;
  write(`path-eval ${o.stage} (--only ${o.only}): ${scope.length} cases in scope, ${pending.length} pending${waiting ? `, ${waiting} still need a draft` : ''}.`);

  const open = openRun(command);
  if (open) {
    if (o.dryRun) {
      write(`Batch ${open.batchId} is still open; a real run collects it at no extra cost.`);
      return;
    }
    await collect(new Anthropic(), command, plan, work, open.batchId, o.stage);
    return;
  }
  if (pending.length === 0) return;

  const targets = o.sample === undefined ? pending : pending.slice(0, o.sample);
  const batch = o.sample === undefined;
  const request = (c: PlanCase): Anthropic.MessageCreateParamsNonStreaming => {
    const draft = work[c.id]?.draft?.value;
    return o.stage === 'draft' || !draft ? draftParams(topics, c) : reviewParams(topics, c, draft);
  };
  const prompt = o.stage === 'draft' ? DRAFT_PROMPT : REVIEW_PROMPT;
  const outputTokens = o.stage === 'draft' ? 3_000 : 1_500;
  const suffix = Math.max(...targets.map((c) => estimateTokens(JSON.stringify(request(c).messages))));
  const est = estimate(targets.length, { prefixTokens: estimateTokens(prompt.text) + 500, suffixTokens: suffix, outputTokens }, batch);
  write(formatEstimate(`seed:path-eval --stage ${o.stage}${batch ? '' : ` --sample ${targets.length}`}`, est, batch));
  if (o.dryRun) return;
  if (!o.go) {
    write('Not started: rerun with --go once the estimate is approved.');
    return;
  }
  assertWithinCap(est.usdNoCache);

  const client = new Anthropic();
  if (batch) {
    const requests = targets.map((c) => ({ custom_id: c.id, params: request(c) }));
    await collect(client, command, plan, work, await submitBatch(client, command, prompt.version, requests), o.stage);
    return;
  }
  let usage: Usage = ZERO_USAGE;
  let accepted = 0;
  try {
    for (const c of targets) {
      // Streamed: long structured replies can outlast a non-streaming client timeout.
      const message = await client.messages.stream(request(c), { maxRetries: 0 }).finalMessage();
      usage = addUsage(usage, fromApiUsage(message.usage));
      if (accept(plan, work, c.id, message, o.stage)) accepted++;
    }
  } finally {
    writeJson(WORK_FILE, work);
    const cost = logSpend({ command: `${command} --sample`, batch: false, requests: targets.length, usage, ref: prompt.version });
    write(`Sample done: ${accepted}/${targets.length} accepted, actual cost ${usd(cost)}.`);
  }
}

function accept(plan: PlanCase[], work: Work, id: string, message: Anthropic.Message, stage: 'draft' | 'review'): boolean {
  const c = plan.find((x) => x.id === id);
  if (!c) {
    reject('path-eval', id, 'not in the plan');
    return false;
  }
  const json = replyJson('path-eval', `${id} ${stage}`, message);
  if (json === undefined) return false;
  const entry = (work[id] ??= {});
  if (stage === 'draft') {
    const draft = acceptDraft(c, json, 'draft');
    if (!draft) return false;
    entry.draft = { promptVersion: DRAFT_PROMPT.version, value: draft };
    delete entry.review;
    return true;
  }
  const raw = z.object({ verdict: z.enum(['keep', 'revise', 'drop']), issues: z.array(z.string()), revised: z.unknown() }).safeParse(json);
  if (!raw.success) {
    reject('path-eval', `${id} review`, 'malformed review', json);
    return false;
  }
  let revised: Draft | null = null;
  if (raw.data.verdict === 'revise') {
    revised = acceptDraft(c, raw.data.revised, 'revision') ?? null;
    if (!revised) return false;
  }
  entry.review = { promptVersion: REVIEW_PROMPT.version, value: { verdict: raw.data.verdict, issues: raw.data.issues, revised } };
  return true;
}

async function collect(client: Anthropic, command: string, plan: PlanCase[], work: Work, batchId: string, stage: 'draft' | 'review'): Promise<void> {
  try {
    await collectBatch(client, command, batchId, (id, message) => accept(plan, work, id, message, stage));
  } finally {
    writeJson(WORK_FILE, work);
  }
  const reviews = Object.values(work).flatMap((w) => (w.review ? [w.review.value.verdict] : []));
  if (stage === 'review') process.stdout.write(`Reviews on file: keep ${reviews.filter((v) => v === 'keep').length}, revise ${reviews.filter((v) => v === 'revise').length}, drop ${reviews.filter((v) => v === 'drop').length}.\n`);
}

// ---------- assemble + check (free) ----------

function assemble(plan: PlanCase[], work: Work, o: PathEvalOptions, write: (line: string) => boolean): void {
  const scope = plan.filter((c) => o.only === 'all' || (o.only === 'smoke') === c.smoke);
  const cases: object[] = [];
  const missing: string[] = [];
  const dropped: string[] = [];
  for (const c of scope) {
    const w = work[c.id];
    const review = w?.review?.promptVersion === REVIEW_PROMPT.version ? w.review.value : undefined;
    if (!w?.draft || !review) {
      missing.push(c.id);
      continue;
    }
    if (review.verdict === 'drop') {
      dropped.push(c.id);
      continue;
    }
    const d = review.verdict === 'revise' && review.revised ? review.revised : w.draft.value;
    cases.push({
      id: c.id,
      topic: c.topic,
      placement: c.placement,
      goal: d.goal,
      weeklyHours: c.weeklyHours,
      formats: c.formats,
      smoke: c.smoke,
      reference: {
        steps: d.steps,
        startBloomMax: startBloomMax(c.placement.stage, c.placement.bloom),
        endBloom: END_BLOOM[c.placement.stage],
        mustCover: d.mustCover,
        orderConstraints: d.orderConstraints,
        misconceptionsToAvoid: d.misconceptionsToAvoid,
        notes: d.notes,
        sop: d.sop,
      },
    });
  }
  if (missing.length > 0 || dropped.length > 0) {
    write(`Not written: ${missing.length} cases lack a draft or review (${missing.join(', ') || '-'}); ${dropped.length} dropped (${dropped.join(', ') || '-'}). Redraft dropped cases before assembling.`);
    return;
  }
  const competentPlus = plan.filter((c) => STAGES.indexOf(c.placement.stage) >= 2).map((c) => `${c.topic} (${c.placement.stage} -> ${STAGES[Math.min(STAGES.indexOf(c.placement.stage) + 1, 4)]})`);
  const file = {
    version: 1,
    description:
      'A9 path-eval golden set (docs/prompts/03-path-eval-set.md), in the format agreed with the API lane (docs/plans/A9-pathing.md). ' +
      'Inputs from seed/_eval/path-eval-plan.json; goals and references drafted and reviewed by Claude Sonnet 5.5 (tools/seed/path-eval.ts) ' +
      'before any A9 generator output existed (see path-eval-v1.provenance.md). smoke: true marks the 30-case smoke subset. ' +
      `Competent-and-above cases need pools for both stages: ${competentPlus.join('; ')}.`,
    cases,
  };
  const problems = checkFile(file, o.expectCases);
  if (problems.length > 0) throw new Error(`path-eval-v1.json fails its check:\n- ${problems.join('\n- ')}`);
  writeJson(OUT_FILE, file);
  write(`Wrote seed/_eval/path-eval-v1.json: ${cases.length} cases (${cases.filter((c) => (c as { smoke: boolean }).smoke).length} smoke); the file check passed.`);
}

const fileSchema = z.object({
  version: z.literal(1),
  description: z.string(),
  cases: z.array(
    z.object({
      id: z.string().regex(/^pe-\d{3}$/),
      topic: z.string(),
      placement: z.object({ stage: z.enum(STAGES), bloom: z.enum(BLOOMS) }),
      goal: z.string().min(3).max(500),
      weeklyHours: z.number().int().min(1).max(40),
      formats: z.array(z.enum(FORMATS)).max(3),
      smoke: z.boolean(),
      reference: z.object({ startBloomMax: z.enum(BLOOMS), endBloom: z.enum(BLOOMS) }).and(draftSchema.omit({ goal: true })),
    }),
  ),
});

/** The file check: schema, ids, slugs, cells, smoke count and the reference rules. */
export function checkFile(raw: unknown, expectCases?: number): string[] {
  const parsed = fileSchema.safeParse(raw);
  if (!parsed.success) return parsed.error.issues.slice(0, 20).map((i) => `${i.path.join('.')}: ${i.message}`);
  const problems: string[] = [];
  const slugs = new Set(parseSeed({ topics: readSeedFiles(SEED_DIR).topics, items: {} }).topics.map((t) => t.slug));
  const ids = new Set<string>();
  for (const c of parsed.data.cases) {
    if (ids.has(c.id)) problems.push(`${c.id}: duplicate id`);
    ids.add(c.id);
    if (!slugs.has(c.topic)) problems.push(`${c.id}: unknown topic ${c.topic}`);
    const [lo, hi] = BAND[c.placement.stage];
    if (bloomIndex(c.placement.bloom) < bloomIndex(lo) || bloomIndex(c.placement.bloom) > bloomIndex(hi)) problems.push(`${c.id}: ${c.placement.bloom} outside the ${c.placement.stage} band`);
    if (c.reference.endBloom !== END_BLOOM[c.placement.stage]) problems.push(`${c.id}: endBloom ${c.reference.endBloom}, expected ${END_BLOOM[c.placement.stage]}`);
    if (c.reference.startBloomMax !== startBloomMax(c.placement.stage, c.placement.bloom)) problems.push(`${c.id}: startBloomMax off`);
    for (const p of checkReference(c, { ...c.reference, goal: c.goal })) problems.push(`${c.id}: ${p}`);
  }
  const smoke = parsed.data.cases.filter((c) => c.smoke).length;
  if (expectCases !== undefined && parsed.data.cases.length !== expectCases) problems.push(`expected ${expectCases} cases, found ${parsed.data.cases.length}`);
  if (parsed.data.cases.length === 90 && smoke !== 30) problems.push(`expected 30 smoke cases, found ${smoke}`);
  return problems;
}

export function validatePathEval(expectCases?: number): void {
  if (!existsSync(OUT_FILE)) throw new Error('seed/_eval/path-eval-v1.json does not exist yet');
  const raw = JSON.parse(readFileSync(OUT_FILE, 'utf8')) as unknown;
  const problems = checkFile(raw, expectCases);
  if (problems.length > 0) throw new Error(`path-eval-v1.json is invalid:\n- ${problems.join('\n- ')}`);
  const cases = (raw as { cases: { smoke: boolean }[] }).cases;
  process.stdout.write(`Valid path-eval v1: ${cases.length} cases, ${cases.filter((c) => c.smoke).length} smoke\n`);
}

function summarisePlan(cases: PlanCase[], write: (line: string) => boolean): void {
  const hoursBucket = (h: number): string => (h <= 2 ? '1-2h' : h <= 5 ? '3-5h' : '6+h');
  const show = (label: string, set: PlanCase[]): void => {
    const by = (f: (c: PlanCase) => string): string => {
      const m = new Map<string, number>();
      for (const c of set) m.set(f(c), (m.get(f(c)) ?? 0) + 1);
      return [...m].sort().map(([k, v]) => `${k} ${v}`).join(', ');
    };
    write(`${label} (${set.length})`);
    write(`  domains:    ${by((c) => c.domain)}`);
    write(`  placements: ${by((c) => `${c.placement.stage} ${c.placement.bloom}`)}`);
    write(`  hours:      ${by((c) => hoursBucket(c.weeklyHours))}`);
    write(`  formats:    ${by((c) => (c.formats.length ? c.formats.join('+') : 'none'))}`);
    write(`  topics:     ${new Set(set.map((c) => c.topic)).size}`);
  };
  show('All cases', cases);
  show('Smoke cases', cases.filter((c) => c.smoke));
  write(`Competent and above: ${cases.filter((c) => STAGES.indexOf(c.placement.stage) >= 2).map((c) => `${c.id} ${c.topic} ${c.placement.stage} ${c.placement.bloom}${c.smoke ? ' (smoke)' : ''}`).join('; ')}`);
}
