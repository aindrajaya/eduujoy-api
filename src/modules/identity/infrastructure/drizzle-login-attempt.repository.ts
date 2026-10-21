import { Inject, Injectable } from '@nestjs/common';
import { and, eq, gt, sql } from 'drizzle-orm';
import { DATABASE, type Database } from '../../../shared/db';
import { loginAttempts } from '../../../shared/db/schema/identity';
import { type LoginAttemptRepository } from '../application/ports/login-attempt.repository';

@Injectable()
export class DrizzleLoginAttemptRepository implements LoginAttemptRepository {
  constructor(@Inject(DATABASE) private readonly db: Database) {}

  async record(email: string, succeeded: boolean, ipHash: string | null): Promise<void> {
    await this.db.insert(loginAttempts).values({ email, succeeded, ipHash });
  }

  async failuresSince(email: string, since: Date): Promise<Date[]> {
    const sameEmail = sql`lower(${loginAttempts.email}) = lower(${email})`;
    const lastSuccess = sql`coalesce((
      SELECT max(${loginAttempts.createdAt}) FROM ${loginAttempts}
      WHERE ${sameEmail} AND ${loginAttempts.succeeded} AND ${loginAttempts.createdAt} > ${since}
    ), ${since})`;
    const rows = await this.db
      .select({ at: loginAttempts.createdAt })
      .from(loginAttempts)
      .where(and(sameEmail, eq(loginAttempts.succeeded, false), gt(loginAttempts.createdAt, lastSuccess)))
      .orderBy(sql`${loginAttempts.createdAt} desc`)
      .limit(50);
    return rows.map((r) => r.at);
  }
}
