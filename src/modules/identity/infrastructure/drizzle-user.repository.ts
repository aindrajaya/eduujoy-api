import { Inject, Injectable } from '@nestjs/common';
import { eq, sql } from 'drizzle-orm';
import { DATABASE, type Database } from '../../../shared/db';
import { userRoles, users } from '../../../shared/db/schema/identity';
import { DuplicateUserError, type NewUser, type UserRecord, type UserRepository } from '../application/ports/user.repository';
import { type Role } from '../domain/role';
import { isUniqueViolation } from './pg-errors';

type UserRow = typeof users.$inferSelect;

@Injectable()
export class DrizzleUserRepository implements UserRepository {
  constructor(@Inject(DATABASE) private readonly db: Database) {}

  findById(id: string): Promise<UserRecord | null> {
    return this.findOne(eq(users.id, id));
  }

  findByEmail(email: string): Promise<UserRecord | null> {
    return this.findOne(sql`lower(${users.email}) = lower(${email})`);
  }

  findByGoogleSub(sub: string): Promise<UserRecord | null> {
    return this.findOne(eq(users.googleSub, sub));
  }

  async create(user: NewUser): Promise<UserRecord> {
    try {
      return await this.db.transaction(async (tx) => {
        const [row] = await tx
          .insert(users)
          .values({
            email: user.email,
            name: user.name,
            passwordHash: user.passwordHash,
            googleSub: user.googleSub,
            emailVerified: user.emailVerified,
          })
          .returning();
        if (!row) throw new Error('User insert returned no row');
        await tx.insert(userRoles).values(user.roles.map((role) => ({ userId: row.id, role })));
        return toRecord(row, [...user.roles]);
      });
    } catch (error) {
      if (isUniqueViolation(error)) throw new DuplicateUserError();
      throw error;
    }
  }

  async linkGoogle(userId: string, sub: string): Promise<UserRecord> {
    const [row] = await this.db
      .update(users)
      .set({ googleSub: sub, emailVerified: true, passwordHash: null })
      .where(eq(users.id, userId))
      .returning();
    if (!row) throw new Error('User to link was not found');
    return toRecord(row, await this.rolesOf(row.id));
  }

  private async findOne(where: ReturnType<typeof eq>): Promise<UserRecord | null> {
    const [row] = await this.db.select().from(users).where(where).limit(1);
    return row ? toRecord(row, await this.rolesOf(row.id)) : null;
  }

  private async rolesOf(userId: string): Promise<Role[]> {
    const rows = await this.db.select({ role: userRoles.role }).from(userRoles).where(eq(userRoles.userId, userId));
    return rows.map((r) => r.role);
  }
}

function toRecord(row: UserRow, roles: Role[]): UserRecord {
  return {
    id: row.id,
    email: row.email,
    name: row.name,
    locale: row.locale,
    weeklyHoursDefault: row.weeklyHoursDefault,
    plan: row.plan,
    passwordHash: row.passwordHash,
    googleSub: row.googleSub,
    emailVerified: row.emailVerified,
    roles,
  };
}
