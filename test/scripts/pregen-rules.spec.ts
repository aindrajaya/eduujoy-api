import { coldPoolsToday, poolStop } from '../../scripts/discovery/pregen-rules';

describe('discovery:pregen stop rules (D1)', () => {
  const base = { spentUsd: 0, capUsd: 35, cold: true, searchesUsed: 0, guard: 90, reserve: 20 };

  it('starts a pool while spend and YouTube room allow', () => {
    expect(poolStop(base)).toBeNull();
    expect(poolStop({ ...base, spentUsd: 34.4 })).toBeNull();
  });

  it('stops before the cap, keeping room for one more pool', () => {
    expect(poolStop({ ...base, spentUsd: 34.41 })).toMatch(/^spend: /);
  });

  it('stops cold pools once only the learner reserve of search.list is left, and says to resume tomorrow', () => {
    expect(poolStop({ ...base, searchesUsed: 68 })).toBeNull();
    expect(poolStop({ ...base, searchesUsed: 69 })).toMatch(/resume tomorrow/);
    // A pool left analysing needs no searches.
    expect(poolStop({ ...base, searchesUsed: 89, cold: false })).toBeNull();
  });

  it('plans 35 cold pools a day with 20 of 90 searches kept, so 100 pools take 3 days', () => {
    expect(coldPoolsToday(0, 90, 20)).toBe(35);
    expect(coldPoolsToday(40, 90, 20)).toBe(15);
    expect(coldPoolsToday(80, 90, 20)).toBe(0);
  });
});
