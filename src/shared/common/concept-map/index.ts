import { z } from 'zod';

/**
 * A topic's concept map (seed/concept-maps/<slug>.json, format agreed 2 Nov 2026 with credit-sprint and
 * the lead): per Dreyfus stage, the concepts it should teach, "a before b" prerequisite pairs and the
 * misconceptions to avoid. Generated from the public catalogue only, never from eval references.
 * Shared kernel: catalog stores and serves maps, pathing consumes them.
 */
const id = z.string().regex(/^[a-z]{3}-\d{1,2}$/);
const bloom = z.enum(['C1', 'C2', 'C3', 'C4', 'C5', 'C6']);

export const conceptMapSchema = z.object({
  version: z.literal(1),
  topic: z.string().min(1).max(200),
  language: z.string().regex(/^[a-z]{2}$/),
  /** The generator prompt's version (provenance). */
  promptVersion: z.string().min(1).max(20).optional(),
  stages: z
    .array(
      z.object({
        stage: z.enum(['novice', 'advanced_beginner', 'competent', 'proficient', 'expert']),
        bloomBand: z.array(bloom).min(1).max(2),
        concepts: z
          .array(z.object({ id, name: z.string().min(1).max(120), aliases: z.array(z.string().min(1).max(120)).max(4).default([]), bloom, summary: z.string().max(400) }))
          .min(1)
          .max(8),
        prerequisites: z.array(z.tuple([id, id])).max(64),
        misconceptions: z.array(z.object({ text: z.string().min(1).max(400), concepts: z.array(id).max(8) })).max(3),
      }),
    )
    .length(5),
});

export type ConceptMap = z.infer<typeof conceptMapSchema>;
export type ConceptMapStage = ConceptMap['stages'][number];

/** The part of a map one path uses: its stages in order, and the edges among their concepts. */
export interface PathConceptMap {
  stages: { stage: ConceptMapStage['stage']; concepts: ConceptMapStage['concepts']; misconceptions: string[] }[];
  /** "a before b" pairs with both ends in these stages; a lower-stage prerequisite is assumed known. */
  prerequisites: [string, string][];
}

/** What the validator needs from a path's map: its ids and its hard order pairs. */
export function conceptMapCheck(map: PathConceptMap | null): { ids: string[]; prerequisites: [string, string][] } | null {
  return map ? { ids: map.stages.flatMap((s) => s.concepts.map((c) => c.id)), prerequisites: map.prerequisites } : null;
}

export function pathConceptMap(map: ConceptMap, stages: readonly string[]): PathConceptMap {
  const picked = map.stages.filter((s) => stages.includes(s.stage));
  const ids = new Set(picked.flatMap((s) => s.concepts.map((c) => c.id)));
  return {
    stages: picked.map((s) => ({ stage: s.stage, concepts: s.concepts, misconceptions: s.misconceptions.map((m) => m.text) })),
    prerequisites: picked.flatMap((s) => s.prerequisites).filter(([a, b]) => ids.has(a) && ids.has(b)),
  };
}
