import { Inject, Injectable } from '@nestjs/common';
import { IDENTITY_CLOCK, type Clock, SECRET_HASHER, type SecretHasher } from './ports/crypto';
import { SESSION_REPOSITORY, type SessionRepository } from './ports/session.repository';

@Injectable()
export class Logout {
  constructor(
    @Inject(SESSION_REPOSITORY) private readonly sessions: SessionRepository,
    @Inject(SECRET_HASHER) private readonly secrets: SecretHasher,
    @Inject(IDENTITY_CLOCK) private readonly clock: Clock,
  ) {}

  /** Revokes the access token's session and, if it belongs to the same user, the refresh cookie's. */
  async execute(userId: string, sessionId: string, refreshToken: string | undefined): Promise<void> {
    const now = this.clock();
    await this.sessions.revoke(sessionId, now);
    if (!refreshToken) return;
    const fromCookie = await this.sessions.findByRefreshHash(this.secrets.hashRefreshToken(refreshToken));
    if (fromCookie && fromCookie.userId === userId && fromCookie.id !== sessionId) {
      await this.sessions.revoke(fromCookie.id, now);
    }
  }
}
