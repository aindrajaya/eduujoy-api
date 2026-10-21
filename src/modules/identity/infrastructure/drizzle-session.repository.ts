import { randomUUID } from 'node:crypto';
import { Inject, Injectable } from '@nestjs/common';
import { and, eq, isNull } from 'drizzle-orm';
import { DATABASE, type Database } from '../../../shared/db';
import { sessions } from '../../../shared/db/schema/identity';
import { type NewSession, type SessionRecord, type SessionRepository } from '../application/ports/session.repository';

const RECORD = {
  id: sessions.id,
  userId: sessions.userId,
  familyId: sessions.familyId,
  expiresAt: sessions.expiresAt,
  revokedAt: sessions.revokedAt,
  replacedBy: sessions.replacedBy,
};

@Injectable()
export class DrizzleSessionRepository implements SessionRepository {
  constructor(@Inject(DATABASE) private readonly db: Database) {}

  async create(session: NewSession): Promise<SessionRecord> {
    const [row] = await this.db.insert(sessions).values(session).returning(RECORD);
    if (!row) throw new Error('Session insert returned no row');
    return row;
  }

  async findByRefreshHash(hash: string): Promise<SessionRecord | null> {
    const [row] = await this.db.select(RECORD).from(sessions).where(eq(sessions.refreshHash, hash)).limit(1);
    return row ?? null;
  }

  rotate(previousId: string, next: NewSession, now: Date): Promise<SessionRecord | null> {
    return this.db.transaction(async (tx) => {
      const nextId = randomUUID();
      // Compare-and-set: only one concurrent request can rotate a given session.
      const claimed = await tx
        .update(sessions)
        .set({ revokedAt: now, replacedBy: nextId })
        .where(and(eq(sessions.id, previousId), isNull(sessions.replacedBy), isNull(sessions.revokedAt)))
        .returning({ id: sessions.id });
      if (claimed.length === 0) return null;
      const [row] = await tx
        .insert(sessions)
        .values({ id: nextId, ...next })
        .returning(RECORD);
      return row ?? null;
    });
  }

  async revoke(id: string, now: Date): Promise<void> {
    await this.db.update(sessions).set({ revokedAt: now }).where(and(eq(sessions.id, id), isNull(sessions.revokedAt)));
  }

  async revokeFamily(familyId: string, now: Date): Promise<void> {
    await this.db
      .update(sessions)
      .set({ revokedAt: now })
      .where(and(eq(sessions.familyId, familyId), isNull(sessions.revokedAt)));
  }

  async revokeAllForUser(userId: string, now: Date): Promise<void> {
    await this.db
      .update(sessions)
      .set({ revokedAt: now })
      .where(and(eq(sessions.userId, userId), isNull(sessions.revokedAt)));
  }
}
