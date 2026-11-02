import { fuzzyMatch, mapNames, strictMatch } from '../../scripts/eval/concept-map-overlap';

describe('concept-map overlap (lead, 3 Nov 2026)', () => {
  it('matches a name or alias strictly after normalising', () => {
    expect(strictMatch('For loops', ['for-loops', 'Variables'])).toBe(true);
    expect(strictMatch('For loops and range()', ['For loops'])).toBe(false);
  });

  it('matches lexically: containment or token overlap, never unrelated names', () => {
    expect(fuzzyMatch('For loops and range()', ['For loops'])).toBe(true);
    expect(fuzzyMatch('Sharding and replication', ['Replication and sharding'])).toBe(true);
    expect(fuzzyMatch('Window functions', ['Indexes', 'Query plans'])).toBe(false);
  });

  it('reads the placement stage and the stage above it, with aliases', () => {
    const map = {
      stages: [
        { stage: 'novice', concepts: [{ name: 'Variables', aliases: ['names'] }] },
        { stage: 'advanced_beginner', concepts: [{ name: 'Loops' }] },
        { stage: 'competent', concepts: [{ name: 'Generators' }] },
      ],
    };
    expect(mapNames(map, 'novice')).toEqual(['Variables', 'names', 'Loops']);
    expect(mapNames({ stages: [{ stage: 'expert', concepts: [{ name: 'Research' }] }] }, 'expert')).toEqual(['Research']);
  });
});
