import { createRemoteJWKSet, jwtVerify, type JWTVerifyGetKey } from 'jose';
import { z } from 'zod';
import { type GoogleIdentity, type GoogleOAuthClient } from '../application/ports/google';

const AUTH_ENDPOINT = 'https://accounts.google.com/o/oauth2/v2/auth';
const TOKEN_ENDPOINT = 'https://oauth2.googleapis.com/token';
const JWKS_URL = 'https://www.googleapis.com/oauth2/v3/certs';
const ISSUERS = ['https://accounts.google.com', 'accounts.google.com'];
const TIMEOUT_MS = 10_000;

const tokenResponse = z.object({ id_token: z.string().min(1) });
const idTokenClaims = z.object({
  sub: z.string().min(1).max(255),
  email: z.email(),
  email_verified: z.boolean(),
  nonce: z.string(),
  name: z.string().max(200).optional(),
});

export class GoogleExchangeError extends Error {
  override name = 'GoogleExchangeError';
}

export interface GoogleClientConfig {
  clientId: string;
  clientSecret: string;
  redirectUri: string;
}

/** Authorization code + PKCE against Google; the id_token is verified locally with Google's JWKS. */
export class GoogleOAuthHttpClient implements GoogleOAuthClient {
  constructor(
    private readonly config: GoogleClientConfig,
    private readonly fetchFn: typeof fetch = fetch,
    private readonly keys: JWTVerifyGetKey = createRemoteJWKSet(new URL(JWKS_URL)),
  ) {}

  authorizationUrl({ state, codeChallenge, nonce }: { state: string; codeChallenge: string; nonce: string }): string {
    const url = new URL(AUTH_ENDPOINT);
    url.search = new URLSearchParams({
      response_type: 'code',
      client_id: this.config.clientId,
      redirect_uri: this.config.redirectUri,
      scope: 'openid email profile',
      state,
      nonce,
      code_challenge: codeChallenge,
      code_challenge_method: 'S256',
      prompt: 'select_account',
    }).toString();
    return url.toString();
  }

  async exchange({ code, codeVerifier, nonce }: { code: string; codeVerifier: string; nonce: string }): Promise<GoogleIdentity> {
    const response = await this.fetchFn(TOKEN_ENDPOINT, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'authorization_code',
        code,
        code_verifier: codeVerifier,
        client_id: this.config.clientId,
        client_secret: this.config.clientSecret,
        redirect_uri: this.config.redirectUri,
      }),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    // Never include the response body: error payloads can echo request parameters.
    if (!response.ok) throw new GoogleExchangeError(`Token endpoint returned ${response.status}`);
    const token = tokenResponse.safeParse(await response.json());
    if (!token.success) throw new GoogleExchangeError('Token response had no id_token');

    const { payload } = await jwtVerify(token.data.id_token, this.keys, {
      issuer: ISSUERS,
      audience: this.config.clientId,
      algorithms: ['RS256'],
    });
    const claims = idTokenClaims.safeParse(payload);
    if (!claims.success) throw new GoogleExchangeError('id_token claims are invalid');
    if (claims.data.nonce !== nonce) throw new GoogleExchangeError('id_token nonce mismatch');
    return {
      sub: claims.data.sub,
      email: claims.data.email,
      emailVerified: claims.data.email_verified,
      name: claims.data.name ?? null,
    };
  }
}
