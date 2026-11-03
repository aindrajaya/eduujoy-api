// Stop rules of `pnpm discovery:pregen` (D1), kept pure so they are unit-tested.

export const POOL_RESERVE_USD = 0.6;
export const ANALYSIS_RESERVE_USD = 0.1;
export const SEARCHES_PER_POOL = 2;

/** Why the next pool may not start, or null. Spend first; YouTube only matters for a cold pool. */
export function poolStop(input: { spentUsd: number; capUsd: number; cold: boolean; searchesUsed: number; guard: number; reserve: number }): string | null {
  if (input.spentUsd + POOL_RESERVE_USD > input.capUsd) return `spend: $${input.spentUsd.toFixed(4)} of the $${input.capUsd} cap`;
  if (input.cold && input.searchesUsed + SEARCHES_PER_POOL > input.guard - input.reserve) {
    return `YouTube search.list guard for today reached (${input.searchesUsed} used, ${input.reserve} kept for learners); resume tomorrow (Pacific day) with the same command`;
  }
  return null;
}

/** A rebuild leaves alone a pool built this recently, so resuming `--rebuild` never pays for it twice. */
export const REBUILD_GRACE_MS = 12 * 3600_000;

/**
 * Whether `--rebuild` should build a new version of this ready (or thin) pool (A8 pilot, 3 Nov 2026).
 * Pools store no creation time, but their expiry was set at build time: ttlMs ahead for a ready pool,
 * a day ahead for a thin one. A pool built within REBUILD_GRACE_MS (by this or an interrupted run) is kept.
 */
export function rebuildPool(pool: { status: string; expiresAt: Date }, now: Date, ttlMs: number, dayMs: number): boolean {
  const lifetime = pool.status === 'thin' ? dayMs : ttlMs;
  const builtAt = pool.expiresAt.getTime() - lifetime;
  return now.getTime() - builtAt >= REBUILD_GRACE_MS;
}

/** Cold pools that still fit today's YouTube room. */
export function coldPoolsToday(searchesUsed: number, guard: number, reserve: number): number {
  return Math.max(0, Math.floor((guard - reserve - searchesUsed) / SEARCHES_PER_POOL));
}
