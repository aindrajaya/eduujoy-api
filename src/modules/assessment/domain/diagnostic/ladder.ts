// The diagnostic ladder (spec: status file, 22 Oct 2026): each Dreyfus stage's Bloom band, in order.
export type Stage = 'novice' | 'advanced_beginner' | 'competent' | 'proficient' | 'expert';
export type Bloom = 'C1' | 'C2' | 'C3' | 'C4' | 'C5' | 'C6';

export interface Cell {
  stage: Stage;
  bloom: Bloom;
}

export const LADDER: readonly Cell[] = [
  { stage: 'novice', bloom: 'C1' },
  { stage: 'novice', bloom: 'C2' },
  { stage: 'advanced_beginner', bloom: 'C2' },
  { stage: 'advanced_beginner', bloom: 'C3' },
  { stage: 'competent', bloom: 'C3' },
  { stage: 'competent', bloom: 'C4' },
  { stage: 'proficient', bloom: 'C4' },
  { stage: 'proficient', bloom: 'C5' },
  { stage: 'expert', bloom: 'C5' },
  { stage: 'expert', bloom: 'C6' },
];

export const TOP = LADDER.length - 1;

export const BLOOM_NAMES: Record<Bloom, string> = {
  C1: 'Remember',
  C2: 'Understand',
  C3: 'Apply',
  C4: 'Analyse',
  C5: 'Evaluate',
  C6: 'Create',
};

export function clampCell(index: number): number {
  return Math.min(TOP, Math.max(0, index));
}

/** Ladder index of a stage and Bloom pair, or -1 when the pair is outside the stage's band. */
export function cellIndex(stage: Stage, bloom: Bloom): number {
  return LADDER.findIndex((c) => c.stage === stage && c.bloom === bloom);
}

export function cellAt(index: number): Cell {
  const cell = LADDER[clampCell(index)];
  if (!cell) throw new Error(`No ladder cell at ${index}`);
  return cell;
}
