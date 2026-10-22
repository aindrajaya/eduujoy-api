export const QUOTA_COUNTER = Symbol('QuotaCounter');

/** Daily provider quota usage (the YouTube `search.list` guard). */
export interface QuotaCounter {
  /** Takes one call if fewer than `limit` were used on `day`; false when the guard is reached. */
  tryTake(quota: string, day: string, limit: number): Promise<boolean>;
  /** Marks the day as used up (the provider said its quota is spent). */
  exhaust(quota: string, day: string, limit: number): Promise<void>;
  used(quota: string, day: string): Promise<number>;
}
