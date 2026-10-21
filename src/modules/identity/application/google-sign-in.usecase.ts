import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { Inject, Injectable } from '@nestjs/common';
import { normalizeEmail } from '../domain/email';
import { DEFAULT_ROLES } from '../domain/role';
import { IDENTITY_CLOCK, type Clock } from './ports/crypto';
import { GOOGLE_OAUTH_CLIENT, type GoogleOAuthClient, OAUTH_STATE_STORE, type OAuthStateStore } from './ports/google';
import { SESSION_REPOSITORY, type SessionRepository } from './ports/session.repository';
import { DuplicateUserError, USER_REPOSITORY, type UserRecord, type UserRepository } from './ports/user.repository';
import { type IssuedSession, type RequestMeta, SessionIssuer } from './session-issuer';

export type OAuthFailure = 'oauth_state' | 'oauth_denied' | 'oauth_failed' | 'email_unverified';

/** Carries where to send the browser back to, so the failure redirect stays on an allowed origin. */
export class OAuthFailedError extends Error {
  override name = 'OAuthFailedError';
  constructor(
    readonly code: OAuthFailure,
    readonly origin: string | null,
  ) {
    super(`Google sign-in failed: ${code}`);
  }
}

const random = (bytes: number): string => randomBytes(bytes).toString('base64url');

function sameSecret(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
}

@Injectable()
export class StartGoogleSignIn {
  constructor(
    @Inject(GOOGLE_OAUTH_CLIENT) private readonly google: GoogleOAuthClient,
    @Inject(OAUTH_STATE_STORE) private readonly states: OAuthStateStore,
  ) {}

  /** `origin` must already be validated against APP_ORIGIN and `returnTo` passed through safeReturnTo. */
  async execute(input: { origin: string; returnTo: string }): Promise<{ redirectUrl: string; sealedState: string }> {
    const state = random(32);
    const codeVerifier = random(48);
    const nonce = random(32);
    const codeChallenge = createHash('sha256').update(codeVerifier).digest('base64url');
    const sealedState = await this.states.seal({ state, codeVerifier, nonce, ...input });
    return { redirectUrl: this.google.authorizationUrl({ state, codeChallenge, nonce }), sealedState };
  }
}

@Injectable()
export class CompleteGoogleSignIn {
  constructor(
    @Inject(GOOGLE_OAUTH_CLIENT) private readonly google: GoogleOAuthClient,
    @Inject(OAUTH_STATE_STORE) private readonly states: OAuthStateStore,
    @Inject(USER_REPOSITORY) private readonly users: UserRepository,
    @Inject(SESSION_REPOSITORY) private readonly sessions: SessionRepository,
    @Inject(IDENTITY_CLOCK) private readonly clock: Clock,
    private readonly issuer: SessionIssuer,
  ) {}

  async execute(
    input: { code?: string; state?: string; error?: string; sealedState?: string },
    meta: RequestMeta,
  ): Promise<{ session: IssuedSession; redirectTo: string }> {
    const saved = input.sealedState ? await this.states.open(input.sealedState) : null;
    if (!saved || !input.state || !sameSecret(saved.state, input.state)) {
      throw new OAuthFailedError('oauth_state', saved?.origin ?? null);
    }
    if (input.error || !input.code) throw new OAuthFailedError('oauth_denied', saved.origin);

    let identity;
    try {
      identity = await this.google.exchange({ code: input.code, codeVerifier: saved.codeVerifier, nonce: saved.nonce });
    } catch {
      throw new OAuthFailedError('oauth_failed', saved.origin);
    }
    if (!identity.emailVerified) throw new OAuthFailedError('email_unverified', saved.origin);

    const user = await this.resolveUser(identity);
    return { session: await this.issuer.start(user, meta), redirectTo: `${saved.origin}${saved.returnTo}` };
  }

  private async resolveUser(identity: { sub: string; email: string; name: string | null }): Promise<UserRecord> {
    const bySub = await this.users.findByGoogleSub(identity.sub);
    if (bySub) return bySub;

    const email = normalizeEmail(identity.email);
    const byEmail = await this.users.findByEmail(email);
    if (byEmail) {
      // Pre-hijack defence: nobody verified this account's email, and Google just did. Drop any
      // password someone else may have set and sign out their sessions before linking.
      await this.sessions.revokeAllForUser(byEmail.id, this.clock());
      return this.users.linkGoogle(byEmail.id, identity.sub);
    }

    try {
      return await this.users.create({
        email,
        name: identity.name,
        passwordHash: null,
        googleSub: identity.sub,
        emailVerified: true,
        roles: DEFAULT_ROLES,
      });
    } catch (error) {
      // A concurrent first sign-in created the account; use it.
      if (error instanceof DuplicateUserError) {
        const existing = await this.users.findByGoogleSub(identity.sub);
        if (existing) return existing;
      }
      throw error;
    }
  }
}
