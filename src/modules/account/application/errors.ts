/** The sign-in behind this session is older than the re-auth window (401 REAUTH_REQUIRED, contract 0.6.0). */
export class ReauthRequiredError extends Error {
  override name = 'ReauthRequiredError';
}

/** The session is unknown or revoked (401 UNAUTHENTICATED). */
export class SessionGoneError extends Error {
  override name = 'SessionGoneError';
}
