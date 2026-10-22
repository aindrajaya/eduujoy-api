export const SESSION_REPOSITORY = Symbol('SessionRepository');

export interface SessionRecord {
  id: string;
  userId: string;
  familyId: string;
  /** The sign-in that started the family; copied by every rotation (see sessions.auth_time). */
  authTime: Date;
  expiresAt: Date;
  revokedAt: Date | null;
  replacedBy: string | null;
}

export interface NewSession {
  userId: string;
  familyId: string;
  refreshHash: string;
  userAgent: string | null;
  ipHash: string | null;
  authTime: Date;
  expiresAt: Date;
}

export interface SessionRepository {
  create(session: NewSession): Promise<SessionRecord>;
  findByRefreshHash(hash: string): Promise<SessionRecord | null>;
  findById(id: string): Promise<SessionRecord | null>;
  /**
   * Atomically marks `previousId` as rotated (revoked_at = now, replaced_by = new id) and inserts
   * `next`. Returns null when another request rotated it first.
   */
  rotate(previousId: string, next: NewSession, now: Date): Promise<SessionRecord | null>;
  revoke(id: string, now: Date): Promise<void>;
  revokeFamily(familyId: string, now: Date): Promise<void>;
  revokeAllForUser(userId: string, now: Date): Promise<void>;
}
