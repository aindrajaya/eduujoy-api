/** Two failed daily checks in a row mark a link dead (lane default, 22 Oct 2026). */
export const DEAD_AFTER_FAILURES = 2;
/** FR-12: served links are re-validated every 24 hours. */
export const LIVENESS_INTERVAL_MS = 24 * 60 * 60 * 1000;
/** YouTube metadata is refreshed before its 30-day limit (YouTube API Services policies III.E.4). */
export const YOUTUBE_METADATA_REFRESH_DAYS = 25;

export function isLiveStatus(status: number): boolean {
  return status >= 200 && status < 300;
}

export interface LivenessUpdate {
  failedChecks: number;
  dead: boolean;
}

export function nextLiveness(failedChecks: number, ok: boolean): LivenessUpdate {
  if (ok) return { failedChecks: 0, dead: false };
  const failures = failedChecks + 1;
  return { failedChecks: failures, dead: failures >= DEAD_AFTER_FAILURES };
}
