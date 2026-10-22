import { type BankItem } from './grading';
import { clampCell, TOP } from './ladder';

export const BATCH_SIZE = 4;
export const MIN_ITEMS = 8;
export const MAX_ITEMS = 12;
const MOVE_UP_AT = 0.75;
const MOVE_DOWN_AT = 0.25;

export interface GradedItem {
  itemId: string;
  cell: number;
  correct: boolean;
}

/** Persisted adaptive state (diagnostic_sessions.state). */
export interface DiagnosticState {
  estimate: number;
  /** Item ids of the batch waiting for answers. */
  current: string[];
  /** Every item ever served, in order. */
  served: string[];
  results: GradedItem[];
  /** Estimate after each answered batch. */
  estimates: number[];
}

/** Batch targets: 2 at the estimate, 1 above, 1 below; shifted inward at the ladder's ends. */
export function batchTargets(estimate: number): number[] {
  const e = clampCell(estimate);
  const above = e < TOP ? e + 1 : e - 1;
  const below = e > 0 ? e - 1 : e + 1;
  return [e, e, above, below];
}

function ordered(items: BankItem[]): BankItem[] {
  return [...items].sort((a, b) => Number(b.reviewed) - Number(a.reviewed) || a.id.localeCompare(b.id));
}

/**
 * Picks the next batch from unseen items. Each target takes the closest unseen item (by cell distance,
 * then reviewed first, then id). Until a scenario item has been served, the batch includes the nearest
 * scenario item within one cell of the estimate; in the batch that could be the last at 8 items it
 * takes the nearest scenario at any distance, so US-02's "at least one scenario item" always holds.
 */
export function selectBatch(estimate: number, bank: BankItem[], served: readonly string[]): BankItem[] {
  const seen = new Set(served);
  const pool = ordered(bank.filter((item) => !seen.has(item.id)));
  const chosen: BankItem[] = [];
  const take = (item: BankItem | undefined): void => {
    if (!item) return;
    chosen.push(item);
    pool.splice(pool.indexOf(item), 1);
  };
  const scenarioServed = bank.some((item) => seen.has(item.id) && item.kind === 'scenario');
  if (!scenarioServed) {
    const mayBeLast = served.length + BATCH_SIZE >= MIN_ITEMS;
    const scenario = pool
      .filter((item) => item.kind === 'scenario' && (mayBeLast || Math.abs(item.cell - estimate) <= 1))
      .sort((a, b) => Math.abs(a.cell - estimate) - Math.abs(b.cell - estimate))[0];
    take(scenario);
  }
  const targets = batchTargets(estimate).slice(chosen.length);
  for (const target of targets) {
    const nearest = [...pool].sort((a, b) => Math.abs(a.cell - target) - Math.abs(b.cell - target))[0];
    take(nearest);
  }
  return chosen;
}

/** Move rule: up one cell at 75%+ correct in the batch, down one cell at 25% or less. */
export function nextEstimate(estimate: number, batch: readonly GradedItem[]): number {
  if (batch.length === 0) return estimate;
  const score = batch.filter((g) => g.correct).length / batch.length;
  if (score >= MOVE_UP_AT) return clampCell(estimate + 1);
  if (score <= MOVE_DOWN_AT) return clampCell(estimate - 1);
  return estimate;
}

/** Stop rule: 12 items, or 8 when the second batch left the estimate where the first put it. */
export function shouldStop(state: Pick<DiagnosticState, 'results' | 'estimates'>): boolean {
  if (state.results.length >= MAX_ITEMS) return true;
  if (state.results.length >= MIN_ITEMS) {
    const [prev, last] = state.estimates.slice(-2);
    return prev !== undefined && prev === last;
  }
  return false;
}

/**
 * The diagnostic ended while the estimate was still rising (the last batch moved it up). One-cell moves
 * and 12 items cap how far a placement can climb from its start (about 3 cells; the A7 "silent expert"
 * edge), so such a placement may sit below the learner's real level. Counted, not corrected (user
 * decision, 22 Oct 2026).
 */
export function endedClimbing(state: Pick<DiagnosticState, 'estimates'>): boolean {
  const [prev, last] = state.estimates.slice(-2);
  return prev !== undefined && last !== undefined && last > prev;
}

/** The learner-facing estimate of how many items this diagnostic will take. */
export function estimatedTotal(state: Pick<DiagnosticState, 'results' | 'estimates'>, done: boolean, unseen: number): number {
  const answered = state.results.length;
  if (done) return answered;
  const target = state.estimates.length >= 2 ? MAX_ITEMS : MIN_ITEMS;
  return Math.min(target, answered + unseen);
}
