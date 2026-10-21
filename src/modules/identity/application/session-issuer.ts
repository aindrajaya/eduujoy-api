import { randomUUID } from 'node:crypto';
import { Inject, Injectable } from '@nestjs/common';
import { AccessTokenService } from '../../../shared/common/auth/access-token.service';
import { REFRESH_TTL_MS } from '../domain/refresh-rotation';
import { IDENTITY_CLOCK, type Clock, SECRET_HASHER, type SecretHasher } from './ports/crypto';
import { type NewSession, SESSION_REPOSITORY, type SessionRepository } from './ports/session.repository';
import { type UserRecord } from './ports/user.repository';

export interface RequestMeta {
  userAgent: string | null;
  ip: string | null;
}

export interface IssuedSession {
  user: UserRecord;
  accessToken: string;
  refreshToken: string;
}

/** Creates session rows and the matching access JWT; shared by every sign-in path. */
@Injectable()
export class SessionIssuer {
  constructor(
    @Inject(SESSION_REPOSITORY) private readonly sessions: SessionRepository,
    @Inject(SECRET_HASHER) private readonly secrets: SecretHasher,
    @Inject(IDENTITY_CLOCK) private readonly clock: Clock,
    private readonly accessTokens: AccessTokenService,
  ) {}

  /** Starts a new session family. */
  async start(user: UserRecord, meta: RequestMeta): Promise<IssuedSession> {
    const { token, next } = this.nextSession(user.id, randomUUID(), meta);
    const session = await this.sessions.create(next);
    return { user, accessToken: await this.sign(user, session.id), refreshToken: token };
  }

  /** Builds the next session of an existing family (used by refresh rotation). */
  nextSession(userId: string, familyId: string, meta: RequestMeta): { token: string; next: NewSession } {
    const { token, hash } = this.secrets.newRefreshToken();
    const expiresAt = new Date(this.clock().getTime() + REFRESH_TTL_MS);
    return {
      token,
      next: {
        userId,
        familyId,
        refreshHash: hash,
        userAgent: meta.userAgent?.slice(0, 512) ?? null,
        ipHash: meta.ip === null ? null : this.secrets.hashIp(meta.ip),
        expiresAt,
      },
    };
  }

  sign(user: UserRecord, sessionId: string): Promise<string> {
    return this.accessTokens.sign(
      { userId: user.id, sessionId, roles: [...user.roles], plan: user.plan },
      this.clock(),
    );
  }
}
