import { batchTargets, endedClimbing, estimatedTotal, nextEstimate, selectBatch, shouldStop } from './adaptive';
import { type BankItem, isCorrect } from './grading';
import { cellIndex, LADDER } from './ladder';
import { placeFromItems, placeFromSelfReport } from './placement';
import { startCell } from './self-report';
import { BatchMismatchError, begin, submit } from './session';

const item = (id: string, cell: number, over: Partial<BankItem> = {}): BankItem => ({
  id,
  cell,
  kind: 'single_choice',
  answerKey: ['a'],
  reviewed: true,
  ...over,
});
/** 3 items per cell, ids like c4-1. */
const fullBank = (): BankItem[] => LADDER.flatMap((_c, cell) => [1, 2, 3].map((n) => item(`c${cell}-${n}`, cell)));
const graded = (cell: number, correct: boolean[]) => correct.map((c, i) => ({ itemId: `g${cell}-${i}`, cell, correct: c }));

describe('ladder', () => {
  it('has 10 cells covering every stage band in order', () => {
    expect(LADDER).toHaveLength(10);
    expect(cellIndex('novice', 'C1')).toBe(0);
    expect(cellIndex('advanced_beginner', 'C2')).toBe(2);
    expect(cellIndex('expert', 'C6')).toBe(9);
    expect(cellIndex('novice', 'C4')).toBe(-1);
  });
});

describe('startCell', () => {
  it.each([
    [undefined, 0],
    [{}, 0],
    [{ years: 0, projectsShipped: 0 }, 1],
    [{ years: 1 }, 2],
    [{ projectsShipped: 3 }, 4],
    [{ years: 6 }, 6],
    [{ years: 2, projectsShipped: 10 }, 6],
    [{ years: 10, projectsShipped: 20 }, 8],
    [{ years: 12, projectsShipped: 5 }, 6],
  ])('maps %j to cell %i', (report, cell) => {
    expect(startCell(report)).toBe(cell);
  });
});

describe('UI self-report choices (single choice, contract selfReport)', () => {
  // ui-lane maps its five choices to these values; pinned so a change here is a contract change.
  it.each([
    ["I'm new to this", { years: 0, projectsShipped: 0 }, 1],
    ['Some experience', { years: 1, projectsShipped: 1 }, 2],
    ['Comfortable', { years: 3, projectsShipped: 3 }, 4],
    ['Experienced', { years: 6, projectsShipped: 10 }, 6],
    ['Expert', { years: 10, projectsShipped: 20 }, 8],
  ])('%s %j starts at cell %d', (_label, report, cell) => {
    expect(startCell(report)).toBe(cell);
  });
});

describe('endedClimbing (the A7 cap signal)', () => {
  it('is true only when the last batch moved the estimate up', () => {
    expect(endedClimbing({ estimates: [1, 2, 3] })).toBe(true);
    expect(endedClimbing({ estimates: [3, 3] })).toBe(false);
    expect(endedClimbing({ estimates: [4, 3] })).toBe(false);
    expect(endedClimbing({ estimates: [1] })).toBe(false);
  });
});

describe('isCorrect', () => {
  it('requires an exact set match and treats skips as wrong', () => {
    const multi = item('m', 0, { kind: 'multi_choice', answerKey: ['a', 'c'] });

    expect(isCorrect(multi, { itemId: 'm', optionIds: ['c', 'a'] })).toBe(true);
    expect(isCorrect(multi, { itemId: 'm', optionIds: ['a'] })).toBe(false);
    expect(isCorrect(multi, { itemId: 'm', optionIds: ['a', 'b', 'c'] })).toBe(false);
    expect(isCorrect(item('s', 0), { itemId: 's', optionIds: ['a'], skipped: true })).toBe(false);
    expect(isCorrect(item('s', 0), { itemId: 's' })).toBe(false);
  });
});

describe('batch selection', () => {
  it('targets 2 at the estimate, 1 above and 1 below, shifting inward at the ends', () => {
    expect(batchTargets(4)).toEqual([4, 4, 5, 3]);
    expect(batchTargets(0)).toEqual([0, 0, 1, 1]);
    expect(batchTargets(9)).toEqual([9, 9, 8, 8]);
  });

  it('serves unseen items at the target cells, reviewed first then by id', () => {
    const bank = [...fullBank(), item('c4-0-unreviewed', 4, { reviewed: false })];

    expect(selectBatch(4, bank, ['c4-1']).map((i) => i.id)).toEqual(['c4-2', 'c4-3', 'c5-1', 'c3-1']);
  });

  it('includes a nearby scenario item until one has been served', () => {
    const bank = [...fullBank(), item('scen-5', 5, { kind: 'scenario' })];

    const first = selectBatch(4, bank, []);
    expect(first[0]?.id).toBe('scen-5');
    expect(first).toHaveLength(4);
    expect(selectBatch(4, bank, ['scen-5']).some((i) => i.kind === 'scenario')).toBe(false);
  });

  it('takes a distant scenario in the batch that could be the last at 8 items', () => {
    const bank = [...fullBank(), item('scen-6', 6, { kind: 'scenario' })];
    const firstFour = ['c0-1', 'c0-2', 'c1-1', 'c1-2'];

    expect(selectBatch(0, bank, []).some((i) => i.kind === 'scenario')).toBe(false);
    expect(selectBatch(0, bank, firstFour)[0]?.id).toBe('scen-6');
  });

  it('falls back to the nearest cells when a target cell is empty, and to fewer items at the end', () => {
    const sparse = [item('a', 0), item('b', 7), item('c', 9)];

    expect(selectBatch(4, sparse, []).map((i) => i.id)).toEqual(['b', 'a', 'c']);
  });
});

describe('move and stop rules', () => {
  it('moves up at 75%+, down at 25% or less, and stays otherwise (clamped)', () => {
    expect(nextEstimate(4, graded(4, [true, true, true, false]))).toBe(5);
    expect(nextEstimate(4, graded(4, [true, false, false, false]))).toBe(3);
    expect(nextEstimate(4, graded(4, [true, true, false, false]))).toBe(4);
    expect(nextEstimate(9, graded(9, [true, true, true, true]))).toBe(9);
    expect(nextEstimate(0, graded(0, [false, false, false, false]))).toBe(0);
  });

  it('stops at 8 when the second batch did not move the estimate, else at 12', () => {
    const eight = graded(0, Array.from({ length: 8 }, () => true));
    expect(shouldStop({ results: eight, estimates: [3, 3] })).toBe(true);
    expect(shouldStop({ results: eight, estimates: [3, 4] })).toBe(false);
    expect(shouldStop({ results: graded(0, Array.from({ length: 12 }, () => true)), estimates: [3, 4, 5] })).toBe(true);
    expect(shouldStop({ results: graded(0, [true, true, true, true]), estimates: [3] })).toBe(false);
  });

  it('estimates 8 items until a second batch moves, then 12, capped by the bank', () => {
    expect(estimatedTotal({ results: [], estimates: [] }, false, 30)).toBe(8);
    expect(estimatedTotal({ results: graded(0, [true, true, true, true]), estimates: [1, 2] }, false, 30)).toBe(12);
    expect(estimatedTotal({ results: graded(0, [true, true, true, true]), estimates: [1] }, false, 2)).toBe(6);
  });
});

describe('placement', () => {
  it('places at the highest cell verified at 80%+ (that cell and below)', () => {
    const results = [...graded(3, [true, true]), ...graded(4, [true, true, true]), ...graded(5, [false, false])];

    const placement = placeFromItems(results);

    expect(placement).toMatchObject({ cell: 4, position: { stage: 'competent', bloom: 'C3' } });
    expect(placement.reason).toBe('3 of 3 Apply items right; 0 of 2 Analyse items right.');
    expect(placement.confidence).toBe(0.99);
  });

  it('counts the cells below toward the 80% (one slip at the top cell can still verify)', () => {
    const results = [...graded(3, [true, true, true, true]), ...graded(4, [true, false])];

    // Cell 4: 5 of 6 at or below = 83%.
    expect(placeFromItems(results).cell).toBe(4);
  });

  it('lowers confidence when the boundary cells have fewer than 2 items', () => {
    const thin = [...graded(3, [true, true, true]), ...graded(4, [true])];

    // All 4 consistent; cell 4 has 1 item (x0.8) and cell 5 has none (x0.8).
    expect(placeFromItems(thin)).toMatchObject({ cell: 4, confidence: 0.64 });
  });

  it('falls back to novice C1 with a basic reason when nothing verifies', () => {
    expect(placeFromItems(graded(2, [false, false, true, false]))).toMatchObject({
      cell: 0,
      position: { stage: 'novice', bloom: 'C1' },
      reason: 'Not enough questions answered correctly yet, so we start from the basics.',
    });
  });

  it('places from the self-report at 0.3 confidence when there is no bank', () => {
    expect(placeFromSelfReport(4)).toMatchObject({ cell: 4, confidence: 0.3, position: { stage: 'competent', bloom: 'C3' } });
  });
});

describe('session flow', () => {
  it('completes at once from the self-report when the topic has no gradable items', () => {
    const step = begin(4, []);

    expect(step).toMatchObject({ done: true, basis: 'self_report', placement: { cell: 4, confidence: 0.3 } });
  });

  it('rejects answers that do not match the outstanding batch', () => {
    const first = begin(4, fullBank());
    if (first.done) throw new Error('expected a batch');
    const answers = first.batch.map((i) => ({ itemId: i.id, optionIds: ['a'] }));
    const [, repeated] = answers;
    if (!repeated) throw new Error('expected 4 answers');

    expect(() => submit(first.state, answers.slice(1), fullBank())).toThrow(BatchMismatchError);
    expect(() => submit(first.state, [...answers.slice(1), repeated], fullBank())).toThrow(BatchMismatchError);
    expect(() => submit(first.state, [...answers.slice(1), { itemId: 'other' }], fullBank())).toThrow(BatchMismatchError);
  });

  it('runs batches of 4 until the stop rule, then places', () => {
    const bank = fullBank();
    let step = begin(4, bank);
    let batches = 0;
    while (!step.done) {
      batches += 1;
      // A learner who knows everything up to cell 5 (competent C4).
      step = submit(step.state, step.batch.map((i) => ({ itemId: i.id, optionIds: i.cell <= 5 ? ['a'] : ['b'] })), bank);
    }

    expect(batches).toBeGreaterThanOrEqual(2);
    expect(batches).toBeLessThanOrEqual(3);
    expect(step.placement.position).toEqual({ stage: 'competent', bloom: 'C4' });
    expect(step.progress.answered).toBe(batches * 4);
  });
});
