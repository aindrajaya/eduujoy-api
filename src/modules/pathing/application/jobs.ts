import { z } from 'zod';
import { STAGES } from '../domain';

// Pathing jobs (PRD-API §5 jobs table).
export const GENERATE_PATH_JOB = 'generate-path';
export const PATH_REFUND_SWEEP_JOB = 'path-refund-sweep';

const stage = z.enum(STAGES as [string, ...string[]]).transform((s) => s as (typeof STAGES)[number]);

/**
 * No PII: the goal and hours live on the path row. `stages` are the pools the path draws on (placement
 * stage first, then the target), also the key JobQueue.wakeWaiting matches when a pool is ready.
 */
export const generatePathPayload = z
  .object({
    pathId: z.uuid(),
    topicId: z.uuid(),
    stages: z.array(stage).min(1).max(2),
    budgetScope: z.enum(['free', 'paid']),
    /** The diagnostic's preferred formats (contract ResourceFormat). */
    formats: z.array(z.enum(['video', 'text', 'papers'])).max(3).default([]),
  })
  .strict();
export type GeneratePathPayload = z.infer<typeof generatePathPayload>;
export type GeneratePathInput = z.input<typeof generatePathPayload>;

export const refundSweepPayload = z.object({ hour: z.string().regex(/^\d{4}-\d{2}-\d{2}T\d{2}$/) }).strict();
