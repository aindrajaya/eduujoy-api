import { z } from 'zod';
import { STAGES } from '../domain';

// Discovery jobs (PRD-API §5 jobs table).
export const DISCOVER_RESOURCES_JOB = 'discover-resources';
export const ANALYSE_RESOURCE_JOB = 'analyse-resource';
export const CHECK_LIVENESS_JOB = 'check-liveness';
export const LIVENESS_SWEEP_JOB = 'liveness-sweep';

const stage = z.enum(STAGES as [string, ...string[]]).transform((s) => s as (typeof STAGES)[number]);
/** D1: the daily budget the discovery and its analyses count against; jobs queued before 0014 are free. */
const budgetScope = z.enum(['free', 'paid', 'operator']).default('free');

export const discoverPayload = z.object({ topicId: z.uuid(), stage, poolVersion: z.number().int().positive(), budgetScope }).strict();
export type DiscoverPayload = z.infer<typeof discoverPayload>;
export type DiscoverInput = z.input<typeof discoverPayload>;

export const analysePayload = z
  .object({
    poolId: z.uuid(),
    resourceId: z.uuid(),
    topicId: z.uuid(),
    stage,
    /** A paper's abstract from OpenAlex (public text), so the analyser needs no second fetch. */
    abstract: z.string().max(20_000).nullable(),
    budgetScope,
  })
  .strict();
export type AnalysePayload = z.infer<typeof analysePayload>;
export type AnalyseInput = z.input<typeof analysePayload>;

export const checkLivenessPayload = z.object({ resourceId: z.uuid() }).strict();
export const livenessSweepPayload = z.object({ day: z.iso.date() }).strict();

/** Runs `fn` over `items` with at most `limit` in flight, keeping input order. */
export async function mapLimit<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  const worker = async (): Promise<void> => {
    while (next < items.length) {
      const index = next++;
      results[index] = await fn(items[index] as T);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}

export const DAY_MS = 24 * 60 * 60 * 1000;
