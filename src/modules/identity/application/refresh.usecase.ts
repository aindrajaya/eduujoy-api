import { Inject, Injectable } from '@nestjs/common';
import { decideRefresh } from '../domain/refresh-rotation';
import { SessionInvalidError } from './errors';
import { IDENTITY_CLOCK, type Clock, SECRET_HASHER, type SecretHasher } from './ports/crypto';
import { SESSION_REPOSITORY, type SessionRepository } from './ports/session.repository';
import { USER_REPOSITORY, type UserRepository } from './ports/user.repository';
import { type IssuedSession, type RequestMeta, SessionIssuer } from './session-issuer';

@Injectable()
export class RefreshSession {
  constructor(
    @Inject(SESSION_REPOSITORY) private readonly sessions: SessionRepository,
    @Inject(USER_REPOSITORY) private readonly users: UserRepository,
    @Inject(SECRET_HASHER) private readonly secrets: SecretHasher,
    @Inject(IDENTITY_CLOCK) private readonly clock: Clock,
    private readonly issuer: SessionIssuer,
  ) {}

  async execute(refreshToken: string | undefined, meta: RequestMeta): Promise<IssuedSession> {
    if (!refreshToken) throw new SessionInvalidError('missing');
    const now = this.clock();
    const session = await this.sessions.findByRefreshHash(this.secrets.hashRefreshToken(refreshToken));
    if (!session) throw new SessionInvalidError('missing');

    const decision = decideRefresh(session, now);
    if (decision === 'reuse') {
      await this.sessions.revokeFamily(session.familyId, now);
      throw new SessionInvalidError('reuse');
    }
    if (decision !== 'rotate') throw new SessionInvalidError(decision);

    const user = await this.users.findById(session.userId);
    if (!user) throw new SessionInvalidError('revoked');

    // A refresh is not a sign-in: the new session keeps the family's original auth time.
    const { token, next } = this.issuer.nextSession(user.id, session.familyId, meta, session.authTime);
    const rotated = await this.sessions.rotate(session.id, next, now);
    if (!rotated) throw new SessionInvalidError('concurrent');
    return { user, accessToken: await this.issuer.sign(user, rotated.id), refreshToken: token };
  }
}
