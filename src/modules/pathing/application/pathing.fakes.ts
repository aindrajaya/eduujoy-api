import { BANDS, BLOOMS, bloomRank } from '../domain';
import { type DesignedPath, type DesignedStep, type DesignRequest, type PathDesigner } from './ports/path-designer';

/**
 * A designer that builds a valid six-step path from whatever pool it gets (tests and e2e): Bloom climbs
 * at most one level a step to the band's top, resources rotate through the pool, and the steps fill
 * half the time budget. `script` answers are used first, e.g. to force a regeneration or a review.
 */
export class FakePathDesigner implements PathDesigner {
  readonly requests: DesignRequest[] = [];
  readonly script: DesignedStep[][] = [];

  design(request: DesignRequest): Promise<DesignedPath> {
    this.requests.push(request);
    const steps = this.script.shift() ?? validSteps(request);
    return Promise.resolve({ steps, model: 'fake-designer', promptVersion: 'v1' });
  }
}

export function validSteps(request: DesignRequest): DesignedStep[] {
  const from = bloomRank(request.placement.bloom);
  const top = bloomRank(BANDS[request.target].top);
  const minutes = Math.max(1, Math.floor(request.budgetMinutes / 12));
  return Array.from({ length: 6 }, (_, i) => {
    const alias = request.cards[i % request.cards.length]?.alias ?? 'r1';
    return {
      n: i + 1,
      objective: `Objective ${i + 1}`,
      bloom: BLOOMS[Math.min(top, from + 1 + Math.floor(i / 2)) - 1] as DesignedStep['bloom'],
      resources: [alias],
      actions: [{ text: `Work through ${alias}.`, resource: null, startSec: null, endSec: null }],
      checkpoint: {
        items: [{ kind: 'single_choice', prompt: 'Which is right?', options: [{ id: 'a', label: 'A' }, { id: 'b', label: 'B' }], correctOptionIds: ['b'], expectedAnswer: null }],
        rubric: ['Correct'],
        passScore: 80,
      },
      doneWhen: 'You can explain it.',
      estMinutes: minutes,
    };
  });
}
