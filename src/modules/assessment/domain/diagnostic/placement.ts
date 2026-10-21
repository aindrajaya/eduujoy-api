import { type GradedItem } from './adaptive';
import { BLOOM_NAMES, type Cell, cellAt, TOP } from './ladder';

const VERIFIED = 0.8;
export const SELF_REPORT_CONFIDENCE = 0.3;

export interface Placement {
  cell: number;
  position: Cell;
  confidence: number;
  reason: string;
}

const round2 = (n: number): number => Math.round(n * 100) / 100;

function tally(results: readonly GradedItem[], cell: number): { right: number; total: number } {
  const at = results.filter((r) => r.cell === cell);
  return { right: at.filter((r) => r.correct).length, total: at.length };
}

/**
 * Placement rule (spec, 22 Oct 2026): the highest cell with at least one answered item where at least
 * 80% of answered items at that cell and below are correct; novice C1 when none qualifies.
 */
export function placeFromItems(results: readonly GradedItem[]): Placement {
  let cell = -1;
  for (let c = TOP; c >= 0; c -= 1) {
    if (!results.some((r) => r.cell === c)) continue;
    const upTo = results.filter((r) => r.cell <= c);
    if (upTo.filter((r) => r.correct).length / upTo.length >= VERIFIED) {
      cell = c;
      break;
    }
  }
  const placed = Math.max(0, cell);

  const consistent = results.filter((r) => (r.cell <= placed ? r.correct : !r.correct)).length;
  let confidence = results.length === 0 ? 0 : consistent / results.length;
  if (tally(results, placed).total < 2) confidence *= 0.8;
  if (placed < TOP && tally(results, placed + 1).total < 2) confidence *= 0.8;
  confidence = round2(Math.min(0.99, Math.max(0.05, confidence)));

  return { cell: placed, position: cellAt(placed), confidence, reason: reasonFor(results, cell) };
}

function reasonFor(results: readonly GradedItem[], cell: number): string {
  if (cell < 0) return 'Not enough questions answered correctly yet, so we start from the basics.';
  const part = (c: number): string => {
    const { right, total } = tally(results, c);
    return `${right} of ${total} ${BLOOM_NAMES[cellAt(c).bloom]} items right`;
  };
  const above = cell < TOP && tally(results, cell + 1).total > 0 ? `; ${part(cell + 1)}` : '';
  return `${part(cell)}${above}.`;
}

/** No item bank for the topic yet: place from the self-report at low confidence (re-placed later). */
export function placeFromSelfReport(start: number): Placement {
  return {
    cell: start,
    position: cellAt(start),
    confidence: SELF_REPORT_CONFIDENCE,
    reason: 'No diagnostic questions for this topic yet, so this placement comes from your self-report.',
  };
}
