import { randomUUID } from 'node:crypto';
import { Inject, Injectable, Logger } from '@nestjs/common';
import { ACCOUNT_DATA, type AccountDataContributor } from '../../../shared/common/account';
import { DeletedUsers } from '../../../shared/common/auth';
import { UnitOfWork } from '../../../shared/events';
import { JobRepository } from '../../../shared/jobs';
import { GetSessionAuthTime } from '../../identity/application/get-session-auth-time.query';
import { ReauthRequiredError, SessionGoneError } from './errors';

/** DELETE /v1/me needs a sign-in (not a refresh) within this window (contract 0.6.0). */
export const REAUTH_WINDOW_MS = 10 * 60 * 1000;

/**
 * DELETE /v1/me. One transaction:
 * 1. billing re-keys its retained ledger and webhook events to a random tombstone and strips their
 *    personal fields (user decision, 22 Oct 2026);
 * 2. the learner's non-running jobs go;
 * 3. identity deletes login attempts and the user row, which cascades sessions, roles, diagnostics,
 *    answers, placements, checkpoint work, positions, feedback, paths and the entitlement, and sets
 *    created_by on topics (and user_id on retained ledger rows and running jobs) to null.
 */
@Injectable()
export class DeleteAccount {
  private readonly logger = new Logger(DeleteAccount.name);

  constructor(
    private readonly authTimes: GetSessionAuthTime,
    private readonly uow: UnitOfWork,
    private readonly jobs: JobRepository,
    @Inject(ACCOUNT_DATA.billing) private readonly billing: AccountDataContributor,
    @Inject(ACCOUNT_DATA.identity) private readonly identity: AccountDataContributor,
    private readonly deletedUsers: DeletedUsers,
  ) {}

  async execute(userId: string, sessionId: string, now: Date = new Date()): Promise<void> {
    const authTime = await this.authTimes.execute(userId, sessionId);
    if (!authTime) throw new SessionGoneError('Session not found');
    if (now.getTime() - authTime.getTime() > REAUTH_WINDOW_MS) throw new ReauthRequiredError('Sign in again to delete the account');

    const tombstone = randomUUID();
    await this.uow.run(async (tx) => {
      await this.billing.erase?.(tx, userId, tombstone);
      await this.jobs.deleteForUser(userId, tx);
      await this.identity.erase?.(tx, userId, tombstone);
    });
    // Its unexpired access tokens stop working now, not when they expire.
    this.deletedUsers.add(userId);
    // The tombstone links retained billing rows for support; it is not the user id and is not stored with it.
    this.logger.log({ tombstone }, 'Account deleted');
  }
}
