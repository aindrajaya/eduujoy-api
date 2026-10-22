import { Inject, Injectable } from '@nestjs/common';
import { SESSION_REPOSITORY, type SessionRepository } from './ports/session.repository';

/**
 * When the learner behind this session last signed in (password or Google), or null when the session
 * is unknown, revoked or someone else's. Public identity query for the account module's re-auth rule.
 */
@Injectable()
export class GetSessionAuthTime {
  constructor(@Inject(SESSION_REPOSITORY) private readonly sessions: SessionRepository) {}

  async execute(userId: string, sessionId: string): Promise<Date | null> {
    const session = await this.sessions.findById(sessionId);
    if (!session || session.userId !== userId || session.revokedAt !== null) return null;
    return session.authTime;
  }
}
