import learners from './learners.json';

export interface FixtureLearner {
  name: string;
  note: string;
  selfReport?: { years?: number; projectsShipped?: number };
  /** Highest ladder cell the learner truly knows (-1: none). */
  knowsUpTo: number;
  /** The learner gets the first item served at this cell wrong despite knowing it. */
  slipAt?: number;
  /** The learner guesses the first item served at this cell right despite not knowing it. */
  luckyAt?: number;
  expected: { stage: string; bloom: string; minConfidence: number; maxConfidence: number };
}

export const FIXTURE_LEARNERS = learners as FixtureLearner[];

/** Picks option ids the way the fixture learner would, given the item's cell and answer key. */
export function answerFor(learner: FixtureLearner, seenCells: Map<number, number>, cell: number, answerKey: readonly string[]): string[] {
  const nth = (seenCells.get(cell) ?? 0) + 1;
  seenCells.set(cell, nth);
  let knows = cell <= learner.knowsUpTo;
  if (learner.slipAt === cell && nth === 1) knows = false;
  if (learner.luckyAt === cell && nth === 1) knows = true;
  return knows ? [...answerKey] : answerKey.includes('a') ? ['b'] : ['a'];
}
