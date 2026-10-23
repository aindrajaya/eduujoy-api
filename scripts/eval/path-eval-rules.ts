import { z } from 'zod';
import { BLOOMS, STAGES, type Stage, targetStage } from '../../src/modules/pathing/domain';

// The pure half of `pnpm eval:paths` (A9, Q8): the case file, selection, the cost estimate and the gate.

const stage = z.enum(STAGES as unknown as [Stage, ...Stage[]]);
const bloom = z.enum(BLOOMS as unknown as [string, ...string[]]);

/** One case of seed/_eval/path-eval-v1.json (format agreed with the credit sprint, plans/A9-pathing.md). */
export const evalCase = z.object({
  id: z.string().regex(/^pe-\d{3}$/),
  topic: z.string().min(1),
  placement: z.object({ stage, bloom }),
  goal: z.string().min(3).max(500),
  weeklyHours: z.number().min(1).max(40),
  formats: z.array(z.enum(['video', 'text', 'papers'])).max(3),
  smoke: z.boolean(),
  reference: z
    .object({
      steps: z.object({ min: z.number().int(), max: z.number().int() }).optional(),
      startBloomMax: bloom.optional(),
      endBloom: bloom.optional(),
      mustCover: z.array(z.string()).optional(),
      orderConstraints: z.array(z.tuple([z.string(), z.string()])).optional(),
      misconceptionsToAvoid: z.array(z.string()).optional(),
      notes: z.string().optional(),
      sop: z.unknown().optional(),
    })
    .loose(),
});
export type EvalCase = z.infer<typeof evalCase>;

export const evalFile = z.object({ version: z.literal(1), description: z.string().optional(), cases: z.array(evalCase).min(1) }).loose();

export function selectCases(cases: EvalCase[], opts: { smoke: boolean; ids: string[] }): EvalCase[] {
  if (opts.ids.length > 0) return cases.filter((c) => opts.ids.includes(c.id));
  return opts.smoke ? cases.filter((c) => c.smoke) : cases;
}

/** The pools a case draws on: its placement stage, then the target (one pool for novices and experts). */
export function caseStages(c: EvalCase): Stage[] {
  const target = targetStage(c.placement.stage);
  return target === c.placement.stage ? [c.placement.stage] : [c.placement.stage, target];
}

/** Every (topic, stage) pool the cases need, once. */
export function poolsNeeded(cases: EvalCase[]): { topic: string; stage: Stage }[] {
  const seen = new Set<string>();
  const out: { topic: string; stage: Stage }[] = [];
  for (const c of cases) {
    for (const s of caseStages(c)) {
      const key = `${c.topic}:${s}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({ topic: c.topic, stage: s });
    }
  }
  return out;
}

/** Post-cap cold pool (EXECUTION-PLAN §8 D1), one Sonnet design (+20% for regenerations) and one judge call. */
export const POOL_USD = 0.3;
export const DESIGN_USD = 0.095 * 1.2;
export const JUDGE_USD = 0.05;
/** A case may not start unless the run has this much of its cap left. */
export const CASE_RESERVE_USD = 0.4;

export function estimate(cases: number, missingPools: number): { poolsUsd: number; pathsUsd: number; totalUsd: number } {
  const round = (n: number): number => Math.round(n * 100) / 100;
  const poolsUsd = round(missingPools * POOL_USD);
  const pathsUsd = round(cases * (DESIGN_USD + JUDGE_USD));
  return { poolsUsd, pathsUsd, totalUsd: round(poolsUsd + pathsUsd) };
}

export const DIMENSIONS = ['prerequisiteOrder', 'bloomProgression', 'resourceFit', 'timeRealism'] as const;
export type Dimension = (typeof DIMENSIONS)[number];

export interface CaseResult {
  id: string;
  /** Null when the path failed validation twice (it would go to review): it scores 1 everywhere. */
  scores: Record<Dimension, number> | null;
  /** Resources the path cited that were not in its pool. */
  badLinks: number;
}

/** Master §11 ship gate: mean ≥ 4.0 on every dimension and 0 invented or dead links. */
export function summarise(results: CaseResult[]): { means: Record<Dimension, number>; badLinks: number; underReview: number; pass: boolean } {
  const means = Object.fromEntries(
    DIMENSIONS.map((d) => [d, results.length ? Math.round((results.reduce((n, r) => n + (r.scores?.[d] ?? 1), 0) / results.length) * 100) / 100 : 0]),
  ) as Record<Dimension, number>;
  const badLinks = results.reduce((n, r) => n + r.badLinks, 0);
  const underReview = results.filter((r) => r.scores === null).length;
  return { means, badLinks, underReview, pass: results.length > 0 && DIMENSIONS.every((d) => means[d] >= 4) && badLinks === 0 };
}
