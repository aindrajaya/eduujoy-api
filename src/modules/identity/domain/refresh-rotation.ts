/** A concurrent refresh from a second tab within this window is rejected but not treated as theft. */
export const REFRESH_GRACE_MS = 10_000;
export const REFRESH_TTL_MS = 30 * 24 * 60 * 60 * 1000;

export interface SessionState {
  expiresAt: Date;
  revokedAt: Date | null;
  replacedBy: string | null;
}

export type RefreshDecision = 'rotate' | 'expired' | 'revoked' | 'reuse' | 'concurrent';

/**
 * Refresh tokens rotate on every use (PRD-API §6). Presenting a rotated token again means it was
 * copied, so the whole family is revoked; the grace window covers two tabs refreshing at once.
 */
export function decideRefresh(session: SessionState, now: Date): RefreshDecision {
  if (session.replacedBy !== null) {
    const rotatedAt = session.revokedAt?.getTime() ?? 0;
    return now.getTime() - rotatedAt <= REFRESH_GRACE_MS ? 'concurrent' : 'reuse';
  }
  if (session.revokedAt !== null) return 'revoked';
  if (session.expiresAt.getTime() <= now.getTime()) return 'expired';
  return 'rotate';
}
