import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import Anthropic from '@anthropic-ai/sdk';
import { inArray } from 'drizzle-orm';
import { Pool } from 'pg';
import { type ServedCard } from '../../src/modules/discovery/application/ports/card.reader';
import { ServedCardsQuery } from '../../src/modules/discovery/application/served-cards.query';
import { DrizzleCardReader } from '../../src/modules/discovery/infrastructure/drizzle-card.reader';
import { designPath } from '../../src/modules/pathing/application/design-loop';
import { ClaudePathDesigner } from '../../src/modules/pathing/infrastructure/claude-path-designer';
import { BANDS, targetStage } from '../../src/modules/pathing/domain';
import { PromptRegistry, type StructuredGenerator, wrapUntrusted } from '../../src/shared/ai';
import { ClaudeStructuredGenerator } from '../../src/shared/ai/claude/claude.generator';
import { DrizzleLlmCallRecorder } from '../../src/shared/ai/metering/llm-call.recorder';
import { MeteredStructuredGenerator } from '../../src/shared/ai/metering/metered';
import { TallyingRecorder } from '../../src/shared/ai/metering/tallying.recorder';
import { createDatabase } from '../../src/shared/db';
import { loadDirectDatabaseUrl } from '../../src/shared/db/cli/env';
import { guardPool, POOL_SETTINGS } from '../../src/shared/db/db.module';
import { describeError } from '../../src/shared/db/redact';
import { topics } from '../../src/shared/db/schema/catalog';
import { buildEvalRequest } from './eval-request';
import { CASE_RESERVE_USD, type CaseResult, caseStages, DIMENSIONS, estimate, type EvalCase, evalFile, judgeSchema, poolsNeeded, selectCases, summarise } from './path-eval-rules';

// Run by the user (A9, Q8): `pnpm eval:paths [--smoke] [--ids pe-001,pe-002] [--cases seed/_eval/path-eval-v1.json]
// [--cap 6] [--dry-run]` (node --env-file=.env), against a database whose pools exist (pregen, or the smoke).
// - Generates each case's path with the production design loop (Sonnet, validator, one regeneration)
//   from the existing placement-stage and target-stage pools. It never starts discovery: a case whose
//   pools are missing is skipped, and `--dry-run` lists those pools with their build cost.
// - A Claude judge (prompt `path-judge`) scores the four master dimensions 1-5 against the case's
//   reference; code counts invented links. A path that fails validation twice scores 1 everywhere.
// - Metered under budget scope `operator` with its own hard stop: no case starts unless spent + 0.40 <= cap.
// - Writes `.smoke/eval-paths-<ts>.json` and prints the gate: mean >= 4.0 on every dimension, 0 bad links.
// - `--check` only proves the wiring loads (no database, no provider). Wired by hand (tsx, no Nest DI).

const JUDGE_MODEL = 'claude-sonnet-5-5';
const JUDGE_PROMPT = 'path-judge';


function env(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} must be in the environment (run with node --env-file=.env)`);
  return value;
}

function arg(name: string, fallback: string): string {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? (process.argv[i + 1] ?? fallback) : fallback;
}

const round = (n: number): number => Math.round(n * 1_000_000) / 1_000_000;

interface EvalRun {
  db: ReturnType<typeof createDatabase>;
  meter: TallyingRecorder;
  prompts: PromptRegistry;
  generator: StructuredGenerator;
  designer: ClaudePathDesigner;
  served: ServedCardsQuery;
}

function build(client: Pool, anthropicKey: string): EvalRun {
  const db = createDatabase(client);
  // Inline calls outside the jobs table: llm_calls rows carry no job id.
  const meter = new TallyingRecorder(new DrizzleLlmCallRecorder(db), { detachJobs: true });
  const prompts = new PromptRegistry();
  const anthropic = new ClaudeStructuredGenerator(new Anthropic({ apiKey: anthropicKey }));
  const generator: StructuredGenerator = new MeteredStructuredGenerator({ anthropic, google: anthropic }, meter);
  const designer = new ClaudePathDesigner(generator, prompts);
  const served = new ServedCardsQuery(new DrizzleCardReader(db));
  return { db, meter, prompts, generator, designer, served };
}

async function main(): Promise<void> {
  const check = process.argv.includes('--check');
  const dryRun = process.argv.includes('--dry-run');
  const smoke = process.argv.includes('--smoke');
  const ids = arg('ids', '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  const capUsd = Number(arg('cap', smoke ? '6' : '16'));
  if (!(capUsd > 0 && capUsd <= 30)) throw new Error('--cap must be above 0 and at most 30 (US$)');

  const pool = guardPool(new Pool({ connectionString: check ? 'postgresql://check@localhost/check' : loadDirectDatabaseUrl(), ...POOL_SETTINGS }), (message) => {
    process.stderr.write(`eval:paths: ${message}\n`);
  });
  const run = build(pool, check || dryRun ? 'check' : env('ANTHROPIC_API_KEY'));
  if (check) {
    run.prompts.get(JUDGE_PROMPT);
    process.stdout.write(`eval:paths: ok (ClaudePathDesigner ${run.designer.promptVersion}, judge ${run.prompts.get(JUDGE_PROMPT).version})\n`);
    return;
  }

  try {
    const file = evalFile.parse(JSON.parse(readFileSync(resolve(arg('cases', join(__dirname, '..', '..', 'seed', '_eval', 'path-eval-v1.json'))), 'utf8')));
    const cases = selectCases(file.cases, { smoke, ids });
    if (cases.length === 0) throw new Error('No cases selected');

    const slugs = [...new Set(cases.map((c) => c.topic))];
    const rows = await run.db.select({ id: topics.id, slug: topics.slug, name: topics.canonicalName, domain: topics.domain }).from(topics).where(inArray(topics.slug, slugs));
    const bySlug = new Map(rows.map((r) => [r.slug, r]));
    const unknown = slugs.filter((s) => !bySlug.has(s));
    if (unknown.length) throw new Error(`Topics not in the database: ${unknown.join(', ')}`);

    const missing: { topic: string; stage: string }[] = [];
    for (const need of poolsNeeded(cases)) {
      const found = await run.served.pool(bySlug.get(need.topic)?.id ?? '', need.stage);
      const ready = found.pool !== null && found.pool.status !== 'analysing' && found.pool.expiresAt > new Date() && found.cards.length > 0;
      if (!ready) missing.push(need);
    }
    const runnable = cases.filter((c) => caseStages(c).every((s) => !missing.some((m) => m.topic === c.topic && m.stage === s)));
    const cost = estimate(cases.length, missing.length);
    process.stdout.write(
      `Plan: ${cases.length} cases (${runnable.length} with their pools ready). Missing pools: ${missing.length} (about $${cost.poolsUsd.toFixed(2)} to build). ` +
        `Paths and judging: about $${cost.pathsUsd.toFixed(2)}. Total with the pools: about $${cost.totalUsd.toFixed(2)} (cap $${capUsd}).\n`,
    );
    if (dryRun) {
      for (const m of missing) process.stdout.write(`  missing pool ${m.topic} (${m.stage})\n`);
      if (missing.length) process.stdout.write('Build them first with `pnpm discovery:pregen` (operator scope); cases without their pools are skipped.\n');
      return;
    }

    const results: (CaseResult & Record<string, unknown>)[] = [];
    let stopped: string | null = null;
    for (const c of cases) {
      if (!runnable.includes(c)) {
        process.stdout.write(`${c.id} ${c.topic}: skipped (no pool)\n`);
        continue;
      }
      if (run.meter.total + CASE_RESERVE_USD > capUsd) {
        stopped = `spend: $${run.meter.total.toFixed(4)} of the $${capUsd} cap before ${c.id}`;
        break;
      }
      run.meter.take();
      try {
        results.push(await evaluate(run, c, bySlug.get(c.topic) as { id: string; name: string; domain: string | null }));
        const last = results.at(-1);
        process.stdout.write(`${c.id} ${c.topic}: ${last?.scores ? DIMENSIONS.map((d) => last.scores?.[d]).join('/') : 'under review'} ($${String(last?.['costUsd'])})\n`);
      } catch (error) {
        const calls = run.meter.take();
        process.stdout.write(`${c.id} ${c.topic}: FAILED, ${describeError(error)}\n`);
        results.push({ id: c.id, scores: null, badLinks: 0, error: describeError(error), costUsd: round(calls.reduce((n, x) => n + x.costUsd, 0)) });
      }
    }

    const gate = summarise(results);
    const summary = {
      at: new Date().toISOString(),
      cases: cases.length,
      judged: results.length,
      skipped: cases.length - runnable.length,
      ...gate,
      totalSpentUsd: round(run.meter.total),
      capUsd,
      stopped,
      recordFailures: run.meter.failures,
    };
    const dir = join(__dirname, '..', '..', '.smoke');
    mkdirSync(dir, { recursive: true });
    const out = join(dir, `eval-paths-${summary.at.replace(/[:.]/g, '-')}.json`);
    writeFileSync(out, `${JSON.stringify({ summary, missingPools: missing, results }, null, 2)}\n`);
    process.stdout.write(`\n${JSON.stringify(summary)}\nGate: ${gate.pass ? 'PASS' : 'FAIL'}. Report: ${out}\n`);
    if (run.meter.failures > 0) process.exitCode = 1;
  } finally {
    await pool.end();
  }
}

/** One case: the production design loop on the existing pools, then the judge. */
async function evaluate(run: EvalRun, c: EvalCase, topic: { id: string; name: string; domain: string | null }): Promise<CaseResult & Record<string, unknown>> {
  const cards: ServedCard[] = [];
  for (const stage of caseStages(c)) {
    for (const card of (await run.served.pool(topic.id, stage)).cards) if (!cards.some((x) => x.resourceId === card.resourceId)) cards.push(card);
  }
  const target = targetStage(c.placement.stage);
  const { request, validate, byAlias, selection } = buildEvalRequest(c, topic, cards, process.env['PATH_RESOURCE_LANGUAGE'] ?? 'en');
  const outcome = await designPath(run.designer, request, { pool: validate, placementBloom: request.placement.bloom, target, weeklyHours: c.weeklyHours });
  const invented = outcome.designed.steps.flatMap((s) => s.resources).filter((a) => !byAlias.has(a)).length;
  const base = {
    id: c.id,
    topic: c.topic,
    placement: c.placement,
    target: `${target} (${BANDS[target].bottom}-${BANDS[target].top})`,
    attempts: outcome.attempts,
    validationErrors: outcome.errors,
    flags: outcome.flags,
    steps: outcome.designed.steps.length,
    totalMinutes: outcome.designed.steps.reduce((n, s) => n + s.estMinutes, 0),
    badLinks: invented,
    selection: { cards: selection.cards.length, droppedForLanguage: selection.droppedForLanguage, formatFallback: selection.formatFallback, coreConcepts: request.coreConcepts },
    // The full designed path, for reviewing the judge's calibration (lead, 2 Nov 2026).
    path: outcome.designed.steps,
    pool: [...byAlias.entries()].map(([alias, card]) => ({ alias, type: card.type, language: card.language, title: card.title, durationMin: card.durationMin, readingMin: card.readingMin })),
  };
  if (outcome.errors.length > 0) {
    return { ...base, scores: null, costUsd: round(run.meter.take().reduce((n, x) => n + x.costUsd, 0)) };
  }

  const path = outcome.designed.steps.map((s) => ({
    n: s.n,
    bloom: s.bloom,
    objective: s.objective,
    estMinutes: s.estMinutes,
    actions: s.actions.map((a) => a.text),
    doneWhen: s.doneWhen,
    checkpoint: s.checkpoint.items.map((i) => `${i.kind}: ${i.prompt}`),
    resources: s.resources.map((alias) => {
      const card = byAlias.get(alias);
      return card ? `${card.type}, ${card.stage}, ${card.durationMin ?? card.readingMin ?? '?'} min: ${card.title}` : `unknown ${alias}`;
    }),
  }));
  const input = [
    `Topic: ${topic.name}`,
    `Learner: ${c.placement.stage}, Bloom ${c.placement.bloom}; path climbs the ${target} band (${BANDS[target].bottom}-${BANDS[target].top}).`,
    wrapUntrusted('learner-goal', c.goal),
    `Weekly hours: ${c.weeklyHours}; preferred formats: ${c.formats.length ? c.formats.join(', ') : 'any'}.`,
    'Reference:',
    wrapUntrusted('reference', JSON.stringify(c.reference)),
    'Generated path:',
    wrapUntrusted('path', JSON.stringify(path)),
  ].join('\n');
  const { output } = await run.generator.generate({
    stage: 'eval',
    model: JUDGE_MODEL,
    prompt: run.prompts.get(JUDGE_PROMPT),
    input,
    schema: judgeSchema,
    maxTokens: 4_000,
    effort: 'medium',
    budgetScope: 'operator',
  });
  const scores = Object.fromEntries(DIMENSIONS.map((d) => [d, output[d].score])) as CaseResult['scores'];
  return {
    ...base,
    scores,
    reasons: Object.fromEntries(DIMENSIONS.map((d) => [d, output[d].reason])),
    missingConcepts: output.missingConcepts,
    misconceptionsReinforced: output.misconceptionsReinforced,
    costUsd: round(run.meter.take().reduce((n, x) => n + x.costUsd, 0)),
  };
}

main().catch((error: unknown) => {
  process.stderr.write(`eval:paths failed: ${describeError(error)}\n`);
  process.exitCode = 1;
});
