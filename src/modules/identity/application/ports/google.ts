export const GOOGLE_OAUTH_CLIENT = Symbol('GoogleOAuthClient');
export const OAUTH_STATE_STORE = Symbol('OAuthStateStore');
/** How long a started Google sign-in may take before the state expires. */
export const OAUTH_STATE_TTL_SECONDS = 10 * 60;

export interface GoogleIdentity {
  sub: string;
  email: string;
  emailVerified: boolean;
  name: string | null;
}

export interface GoogleOAuthClient {
  authorizationUrl(input: { state: string; codeChallenge: string; nonce: string }): string;
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
}

export interface OAuthStateStore {
  seal(state: OAuthState): Promise<string>;
  open(sealed: string): Promise<OAuthState | null>;
}
