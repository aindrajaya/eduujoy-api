/**
 * Retiring seed items (user decision, 2 Nov 2026): an item no longer in the seed files becomes inactive
 * (retired_at), is never served to a new session, and keeps its row for history. db:seed applies it
 * in its own transaction, to the seed topics the files contain. No override for any check (lead gate).
 */

/** At most 1% of the active seed-topic items, or 200, whichever is lower, may be retired in one run. */
export function retirementCap(activeSeedItems: number): number {
  return Math.min(Math.floor(activeSeedItems * 0.01), 200);
}

export type RetireRefusal = 'files_short' | 'over_cap' | 'expect_missing' | 'count_mismatch';

/**
 * Null when the run may retire `toRetire` items. A wrong --dir, a partial checkout or a seed_key format
 * change would otherwise retire the whole bank, so: the files must hold nearly as many items as the
 * database's active seed-topic items, the count must be under the cap, and when anything is retired
 * the caller must have stated the exact count (--expect-retired).
 */
export function retireRefusal(input: { toRetire: number; activeSeedItems: number; filesItems: number; expectRetired: number | undefined }): RetireRefusal | null {
  const cap = retirementCap(input.activeSeedItems);
  if (input.filesItems < input.activeSeedItems - cap) return 'files_short';
  if (input.toRetire > cap) return 'over_cap';
  if (input.toRetire > 0 && input.expectRetired === undefined) return 'expect_missing';
  if (input.expectRetired !== undefined && input.toRetire !== input.expectRetired) return 'count_mismatch';
  return null;
}

export class SeedRetireRefusedError extends Error {
  override name = 'SeedRetireRefusedError';

  constructor(
    readonly refusal: RetireRefusal,
    readonly detail: { toRetire: number; activeSeedItems: number; filesItems: number; cap: number; expectRetired: number | undefined; keys: string[] },
  ) {
    const messages: Record<RetireRefusal, string> = {
      files_short: `the files hold ${detail.filesItems} items but the database has ${detail.activeSeedItems} active seed-topic items; more than ${detail.cap} missing means a wrong or partial --dir`,
      over_cap: `${detail.toRetire} items would retire, over the cap of ${detail.cap} (1% of active seed-topic items, at most 200)`,
      expect_missing: `${detail.toRetire} items would retire; re-run with --expect-retired ${detail.toRetire} to confirm`,
      count_mismatch: `${detail.toRetire} items would retire, not the --expect-retired ${String(detail.expectRetired)}`,
    };
    super(`Refused, nothing written: ${messages[refusal]}`);
  }
}
