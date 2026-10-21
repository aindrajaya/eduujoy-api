import { Inject, Injectable } from '@nestjs/common';
import { IDENTITY_CLOCK, type Clock, SECRET_HASHER, type SecretHasher } from './ports/crypto';
import { SESSION_REPOSITORY, type SessionRepository } from './ports/session.repository';

export interface LogoutCommand {
  /** `sid` from a valid access token, when one was sent. */
  sessionId?: string;
  /** The `ej_rt` cookie, when one was sent. */
  refreshToken?: string;
}

/**
 * Works without a valid access token: an expired `ej_at` must not stop sign-out. Presenting a
 * refresh token proves possession of its session, so revoking that session is always safe.
 */
@Injectable()
export class Logout {
  constructor(
    @Inject(SESSION_REPOSITORY) private readonly sessions: SessionRepository,
    @Inject(SECRET_HASHER) private readonly secrets: SecretHasher,
    @Inject(IDENTITY_CLOCK) private readonly clock: Clock,
  ) {}

  async execute(command: LogoutCommand): Promise<void> {
    const now = this.clock();
    if (command.refreshToken) {
      const session = await this.sessions.findByRefreshHash(this.secrets.hashRefreshToken(command.refreshToken));
      if (session) await this.sessions.revoke(session.id, now);
    }
    if (command.sessionId) await this.sessions.revoke(command.sessionId, now);
  }
}
