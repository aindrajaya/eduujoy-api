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

/** Cold pools that still fit today's YouTube room. */
export function coldPoolsToday(searchesUsed: number, guard: number, reserve: number): number {
  return Math.max(0, Math.floor((guard - reserve - searchesUsed) / SEARCHES_PER_POOL));
}
