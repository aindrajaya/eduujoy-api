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

const STOP = new Set(['a', 'an', 'the', 'of', 'and', 'or', 'to', 'in', 'on', 'for', 'with', 'vs', 'versus', 'how', 'what', 'why', 'using', 'use', 'basic', 'basics', 'its', 'their']);

/** Lowercase, punctuation to spaces, single spaces (as pathing compares concept names). */
export function normaliseConceptName(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^\p{L}\p{N}+#]+/gu, ' ')
    .trim()
    .replace(/\s+/g, ' ');
}

function tokens(s: string): Set<string> {
  return new Set(
    normaliseConceptName(s)
      .split(' ')
      .filter((t) => t && !STOP.has(t)),
  );
}

/** Lexical match of a concept name against map names and aliases: equal, contained (4+ chars), or token Jaccard ≥ 0.5. */
export function conceptMatches(concept: string, names: readonly string[]): boolean {
  const n = normaliseConceptName(concept);
  const t = tokens(concept);
  return names.some((x) => {
    const m = normaliseConceptName(x);
    if (m === n) return true;
    if (Math.min(m.length, n.length) >= 4 && (m.includes(n) || n.includes(m))) return true;
    const u = tokens(x);
    const shared = [...t].filter((w) => u.has(w)).length;
    return t.size > 0 && u.size > 0 && shared / new Set([...t, ...u]).size >= 0.5;
  });
}

/** A map's concept names and aliases at `stage` and the stages either side of it. */
export function namesNearStage(map: ConceptMap, stage: string): string[] {
  const order = ['novice', 'advanced_beginner', 'competent', 'proficient', 'expert'];
  const at = order.indexOf(stage);
  return map.stages.filter((s) => Math.abs(order.indexOf(s.stage) - at) <= 1).flatMap((s) => s.concepts.flatMap((c) => [c.name, ...c.aliases]));
}
