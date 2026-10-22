import { Inject, Injectable } from '@nestjs/common';
import { asc, eq, sql } from 'drizzle-orm';
import { type AccountDataContributor } from '../../../shared/common/account';
import { DATABASE, type Database, type Tx } from '../../../shared/db';
import { loginAttempts, sessions, userRoles, users } from '../../../shared/db/schema/identity';

/** Profile, roles and sign-in sessions. Never the password hash, Google subject, refresh or IP hashes. */
@Injectable()
export class IdentityAccountData implements AccountDataContributor {
  readonly section = 'account';

  constructor(@Inject(DATABASE) private readonly db: Database) {}

  async export(userId: string): Promise<unknown> {
    const [user] = await this.db
      .select({
        id: users.id,
        email: users.email,
        name: users.name,
        locale: users.locale,
        emailVerified: users.emailVerified,
        hasPassword: sql<boolean>`${users.passwordHash} is not null`,
        googleLinked: sql<boolean>`${users.googleSub} is not null`,
        createdAt: users.createdAt,
      })
      .from(users)
      .where(eq(users.id, userId));
    const roles = await this.db.select({ role: userRoles.role }).from(userRoles).where(eq(userRoles.userId, userId));
    const signIns = await this.db
      .select({ createdAt: sessions.createdAt, signedInAt: sessions.authTime, expiresAt: sessions.expiresAt, revokedAt: sessions.revokedAt, userAgent: sessions.userAgent })
      .from(sessions)
      .where(eq(sessions.userId, userId))
      .orderBy(asc(sessions.createdAt));
    return { user: user ?? null, roles: roles.map((r) => r.role), sessions: signIns };
  }

  /** Last step: deleting the user cascades roles, sessions and every user-owned row (see the A13 notes). */
  async erase(tx: Tx, userId: string): Promise<void> {
    const [user] = await tx.select({ email: users.email }).from(users).where(eq(users.id, userId));
    if (!user) return;
    // Login attempts are keyed by email, not by the user row.
    await tx.delete(loginAttempts).where(sql`lower(${loginAttempts.email}) = lower(${user.email})`);
    await tx.delete(users).where(eq(users.id, userId));
  }
}
