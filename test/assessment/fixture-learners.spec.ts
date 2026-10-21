import { begin, cellAt, startCell, submit } from '../../src/modules/assessment/domain/diagnostic';
import { fixtureBank } from '../fixtures/diagnostic/bank';
import { answerFor, FIXTURE_LEARNERS } from '../fixtures/diagnostic/learner';

const bank = fixtureBank().map((item) => ({ id: item.key, cell: item.cell, kind: item.kind, answerKey: item.answerKey, reviewed: true }));

describe('fixture learners through the diagnostic rules (unit)', () => {
  it.each(FIXTURE_LEARNERS.map((l) => [l.name, l] as const))('%s', (_name, learner) => {
    const seen = new Map<number, number>();
    let step = begin(startCell(learner.selfReport), bank);
    let items = 0;
    let scenarios = 0;
    while (!step.done) {
      items += step.batch.length;
      scenarios += step.batch.filter((i) => i.kind === 'scenario').length;
      step = submit(step.state, step.batch.map((i) => ({ itemId: i.id, optionIds: answerFor(learner, seen, i.cell, i.answerKey) })), bank);
    }

    expect(step.basis).toBe('items');
    expect(items).toBeGreaterThanOrEqual(8);
    expect(items).toBeLessThanOrEqual(12);
    expect(scenarios).toBeGreaterThanOrEqual(1);
    expect(step.placement.position).toEqual({ stage: learner.expected.stage, bloom: learner.expected.bloom });
    expect(step.placement.confidence).toBeGreaterThanOrEqual(learner.expected.minConfidence);
    expect(step.placement.confidence).toBeLessThanOrEqual(learner.expected.maxConfidence);
    expect(cellAt(step.placement.cell)).toEqual(step.placement.position);
  });
});
