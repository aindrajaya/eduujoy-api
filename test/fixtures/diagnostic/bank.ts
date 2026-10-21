import { LADDER } from '../../../src/modules/assessment/domain/diagnostic';
import { type SeedFiles } from '../../../src/shared/db/seed/seed-data';

// A synthetic diagnostic bank shared by the unit simulation and diagnostic.e2e-spec: every ladder cell
// has two single-choice items (key b) and one multi-choice item (key a+c), plus scenario items at
// cells 2, 5 and 8 (key b). Item keys encode the cell: `c<cell>-<n>`.

export interface FixtureItem {
  key: string;
  cell: number;
  kind: 'single_choice' | 'multi_choice' | 'scenario';
  answerKey: string[];
}

const SCENARIO_CELLS = new Set([2, 5, 8]);

export function fixtureBank(): FixtureItem[] {
  return LADDER.flatMap((_cell, cell) => [
    { key: `c${cell}-1`, cell, kind: 'single_choice' as const, answerKey: ['b'] },
    { key: `c${cell}-2`, cell, kind: 'single_choice' as const, answerKey: ['b'] },
    { key: `c${cell}-3`, cell, kind: 'multi_choice' as const, answerKey: ['a', 'c'] },
    ...(SCENARIO_CELLS.has(cell) ? [{ key: `c${cell}-s`, cell, kind: 'scenario' as const, answerKey: ['b'] }] : []),
  ]);
}

/** The same bank as seed format v1 items for one topic, so e2e loads it through the real seed loader. */
export function fixtureBankSeed(topicSlug: string, topicName: string): SeedFiles {
  return {
    topics: {
      version: 1,
      topics: [{ slug: topicSlug, canonicalName: topicName, aliases: [], description: 'Diagnostic fixture topic.', domain: 'software', parent: null, prerequisites: [] }],
    },
    items: {
      [topicSlug]: {
        version: 1,
        topic: topicSlug,
        items: fixtureBank().map((item) => {
          const cell = LADDER[item.cell];
          if (!cell) throw new Error(`bad cell ${item.cell}`);
          return {
            key: item.key,
            stage: cell.stage,
            bloom: cell.bloom,
            kind: item.kind,
            prompt: `Fixture question ${item.key}`,
            options: [
              { id: 'a', label: 'Option A' },
              { id: 'b', label: 'Option B' },
              { id: 'c', label: 'Option C' },
            ],
            answerKey: { optionIds: item.answerKey },
            reviewed: true,
          };
        }),
      },
    },
  };
}
