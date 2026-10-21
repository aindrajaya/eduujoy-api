import { type DiagnosticState, estimatedTotal, type GradedItem, nextEstimate, selectBatch, shouldStop } from './adaptive';
import { type Answer, type BankItem, isCorrect } from './grading';
import { type Placement, placeFromItems, placeFromSelfReport } from './placement';

export interface Progress {
  answered: number;
  estimatedTotal: number;
}

export type Step =
  | { done: false; state: DiagnosticState; batch: BankItem[]; progress: Progress }
  | { done: true; state: DiagnosticState; placement: Placement; basis: 'items' | 'self_report'; progress: Progress };

/** Answers that don't cover exactly the outstanding batch (missing, extra or repeated items). */
export class BatchMismatchError extends Error {
  override name = 'BatchMismatchError';
}

function unseenCount(bank: readonly BankItem[], state: DiagnosticState): number {
  const seen = new Set(state.served);
  return bank.filter((item) => !seen.has(item.id)).length;
}

/** Starts a diagnostic at the self-report cell; with no gradable items it completes at once. */
export function begin(start: number, bank: BankItem[]): Step {
  const empty: DiagnosticState = { estimate: start, current: [], served: [], results: [], estimates: [] };
  const batch = selectBatch(start, bank, []);
  if (batch.length === 0) {
    return { done: true, state: empty, placement: placeFromSelfReport(start), basis: 'self_report', progress: { answered: 0, estimatedTotal: 0 } };
  }
  const state = { ...empty, current: batch.map((i) => i.id), served: batch.map((i) => i.id) };
  return { done: false, state, batch, progress: { answered: 0, estimatedTotal: estimatedTotal(state, false, unseenCount(bank, state) + batch.length) } };
}

/** Grades the outstanding batch, moves the estimate, and serves the next batch or the placement. */
export function submit(state: DiagnosticState, answers: readonly Answer[], bank: BankItem[]): Step {
  const byId = new Map(bank.map((item) => [item.id, item]));
  const ids = answers.map((a) => a.itemId);
  const current = new Set(state.current);
  if (ids.length !== current.size || new Set(ids).size !== ids.length || ids.some((id) => !current.has(id))) {
    throw new BatchMismatchError('Answers must cover exactly the current batch');
  }
  const graded: GradedItem[] = answers.map((answer) => {
    const item = byId.get(answer.itemId);
    if (!item) throw new BatchMismatchError(`Unknown item ${answer.itemId}`);
    return { itemId: item.id, cell: item.cell, correct: isCorrect(item, answer) };
  });

  const results = [...state.results, ...graded];
  const estimate = nextEstimate(state.estimate, graded);
  const answered: DiagnosticState = { ...state, estimate, current: [], results, estimates: [...state.estimates, estimate] };

  const next = shouldStop(answered) ? [] : selectBatch(estimate, bank, answered.served);
  if (next.length === 0) {
    return { done: true, state: answered, placement: placeFromItems(results), basis: 'items', progress: { answered: results.length, estimatedTotal: results.length } };
  }
  const state2 = { ...answered, current: next.map((i) => i.id), served: [...answered.served, ...next.map((i) => i.id)] };
  return {
    done: false,
    state: state2,
    batch: next,
    progress: { answered: results.length, estimatedTotal: estimatedTotal(state2, false, unseenCount(bank, state2) + next.length) },
  };
}
