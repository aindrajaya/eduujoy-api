// PRD-API §12: lock an account after 10 failed logins in 15 minutes.
export const LOCKOUT_MAX_FAILURES = 10;
export const LOCKOUT_WINDOW_MS = 15 * 60 * 1000;

export type LockoutStatus = { locked: false } | { locked: true; retryAfterSeconds: number };

export function lockoutStatus(failures: Date[], now: Date): LockoutStatus {
  const windowStart = now.getTime() - LOCKOUT_WINDOW_MS;
  const recent = failures
    .map((at) => at.getTime())
    .filter((at) => at > windowStart)
    .sort((a, b) => b - a)
    .slice(0, LOCKOUT_MAX_FAILURES);
  if (recent.length < LOCKOUT_MAX_FAILURES) return { locked: false };

  // Unlocks once the oldest of the latest ten failures leaves the window.
  const oldest = recent[recent.length - 1] ?? now.getTime();
  const retryAfterSeconds = Math.max(1, Math.ceil((oldest + LOCKOUT_WINDOW_MS - now.getTime()) / 1000));
  return { locked: true, retryAfterSeconds };
}
