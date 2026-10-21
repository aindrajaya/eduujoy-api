import { createHmac } from 'node:crypto';
import { errors, jwtVerify, SignJWT } from 'jose';
import { z } from 'zod';
import { OAUTH_STATE_TTL_SECONDS, type OAuthState, type OAuthStateStore } from '../application/ports/google';
import { isSafeReturnTo } from '../domain/return-to';

const AUDIENCE = 'eduujoy-oauth-state';

const stateSchema = z.object({
  state: z.string().min(32).max(128),
  codeVerifier: z.string().min(43).max(128),
  nonce: z.string().min(32).max(128),
  origin: z.url(),
  returnTo: z.string().refine(isSafeReturnTo, { error: 'returnTo must be a safe same-site path' }),
});

/** Signs the OAuth round-trip state; the key is derived so it can never verify as an access token. */
export class JoseOAuthStateStore implements OAuthStateStore {
  private readonly key: Uint8Array;

  constructor(
    accessSecret: string,
    private readonly issuer: string,
  ) {
    this.key = createHmac('sha256', accessSecret).update('eduujoy:oauth-state:v1').digest();
  }

  seal(state: OAuthState): Promise<string> {
    return new SignJWT({ ...state })
      .setProtectedHeader({ alg: 'HS256' })
      .setIssuer(this.issuer)
      .setAudience(AUDIENCE)
      .setIssuedAt()
      .setExpirationTime(`${OAUTH_STATE_TTL_SECONDS}s`)
      .sign(this.key);
  }

  async open(sealed: string): Promise<OAuthState | null> {
    try {
      const { payload } = await jwtVerify(sealed, this.key, { algorithms: ['HS256'], issuer: this.issuer, audience: AUDIENCE });
      const parsed = stateSchema.safeParse(payload);
      return parsed.success ? parsed.data : null;
    } catch (error) {
      if (error instanceof errors.JOSEError || error instanceof TypeError) return null;
      throw error;
    }
  }
}
