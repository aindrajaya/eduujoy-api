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

/** A re-authentication counts only if Google signed the learner in this recently (DELETE /v1/me's window). */
export const REAUTH_FRESH_MS = 10 * 60 * 1000;
/** Tolerated clock difference with Google when auth_time is slightly ahead of our clock. */
export const AUTH_TIME_SKEW_MS = 60 * 1000;
/** A re-authentication that can't be verified as fresh: the sign-in works, deletion still asks again. */
export const UNVERIFIED_AUTH_TIME = new Date(0);

/**
 * The session's auth time after a Google re-authentication: the id_token's auth_time when it is an
 * integer within the last 10 minutes (and not more than the skew in the future), else the epoch.
 */
export function reauthTime(authTime: number | null, now: Date): Date {
  if (authTime === null || !Number.isSafeInteger(authTime)) return UNVERIFIED_AUTH_TIME;
  const at = authTime * 1000;
  if (at > now.getTime() + AUTH_TIME_SKEW_MS || now.getTime() - at > REAUTH_FRESH_MS) return UNVERIFIED_AUTH_TIME;
  return new Date(Math.min(at, now.getTime()));
}

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
  async execute(input: { origin: string; returnTo: string; reauth?: boolean }): Promise<{ redirectUrl: string; sealedState: string }> {
    const reauth = input.reauth === true;
    const state = random(32);
    const codeVerifier = random(48);
    const nonce = random(32);
    const codeChallenge = createHash('sha256').update(codeVerifier).digest('base64url');
    const sealedState = await this.states.seal({ state, codeVerifier, nonce, origin: input.origin, returnTo: input.returnTo, reauth });
    return { redirectUrl: this.google.authorizationUrl({ state, codeChallenge, nonce, reauth }), sealedState };
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
    // Only a verified Google re-authentication counts as a fresh sign-in. A normal Google sign-in can
    // complete silently from the browser's Google session (an unattended device), so it gets the
    // epoch: it signs in, but DELETE /v1/me asks for a reauth (lead security gate, A13 follow-ups).
    const authTime = saved.reauth ? reauthTime(identity.authTime, this.clock()) : UNVERIFIED_AUTH_TIME;
    return { session: await this.issuer.start(user, meta, authTime), redirectTo: `${saved.origin}${saved.returnTo}` };
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
