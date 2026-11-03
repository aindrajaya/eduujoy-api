import { coldPoolsToday, poolStop, REBUILD_GRACE_MS, rebuildPool } from '../../scripts/discovery/pregen-rules';

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

describe('rebuildPool (A8 pilot, 3 Nov 2026)', () => {
  const DAY = 86_400_000;
  const TTL = 30 * DAY;
  const now = new Date('2026-11-03T12:00:00Z');
  const builtAgo = (ms: number, status = 'ready') => ({ status, expiresAt: new Date(now.getTime() - ms + (status === 'thin' ? DAY : TTL)) });

  it('rebuilds a pool built before the grace window, and keeps one built within it (a resumed --rebuild never pays twice)', () => {
    expect(rebuildPool(builtAgo(11 * DAY), now, TTL, DAY)).toBe(true);
    expect(rebuildPool(builtAgo(REBUILD_GRACE_MS), now, TTL, DAY)).toBe(true);
    expect(rebuildPool(builtAgo(2 * 3600_000), now, TTL, DAY)).toBe(false);
    expect(rebuildPool(builtAgo(2 * 3600_000, 'thin'), now, TTL, DAY)).toBe(false);
    expect(rebuildPool(builtAgo(20 * 3600_000, 'thin'), now, TTL, DAY)).toBe(true);
  });
});
