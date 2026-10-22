export const GOOGLE_OAUTH_CLIENT = Symbol('GoogleOAuthClient');
export const OAUTH_STATE_STORE = Symbol('OAuthStateStore');
/** How long a started Google sign-in may take before the state expires. */
export const OAUTH_STATE_TTL_SECONDS = 10 * 60;

export interface GoogleIdentity {
  sub: string;
  email: string;
  emailVerified: boolean;
  name: string | null;
  /** The id_token's `auth_time` (seconds since the epoch), when Google sent one; it does for `max_age`. */
  authTime: number | null;
}

export interface GoogleOAuthClient {
  /** `reauth` asks Google for a fresh sign-in (prompt=login, max_age=0) so the id_token carries auth_time. */
  authorizationUrl(input: { state: string; codeChallenge: string; nonce: string; reauth: boolean }): string;
  /** Exchanges the code (with the PKCE verifier) and returns the verified id_token claims. */
  exchange(input: { code: string; codeVerifier: string; nonce: string }): Promise<GoogleIdentity>;
}

/** Everything the callback needs, carried in a signed, short-lived HttpOnly cookie. */
export interface OAuthState {
  state: string;
  codeVerifier: string;
  nonce: string;
  origin: string;
  returnTo: string;
  /** Started as a re-authentication (contract 0.8.0); signed with the rest, so it can't be forged. */
  reauth: boolean;
}

export interface OAuthStateStore {
  seal(state: OAuthState): Promise<string>;
  open(sealed: string): Promise<OAuthState | null>;
}
