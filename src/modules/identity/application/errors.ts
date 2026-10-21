/** Application errors; the interface layer maps them to problem+json. */
export class EmailTakenError extends Error {
  override name = 'EmailTakenError';
}

export class InvalidCredentialsError extends Error {
  override name = 'InvalidCredentialsError';
}

export class AccountLockedError extends Error {
  override name = 'AccountLockedError';
  constructor(readonly retryAfterSeconds: number) {
    super('Account temporarily locked');
  }
}

export class InvalidPasswordError extends Error {
  override name = 'InvalidPasswordError';
}

export type SessionFailure = 'missing' | 'expired' | 'revoked' | 'reuse' | 'concurrent';
export class SessionInvalidError extends Error {
  override name = 'SessionInvalidError';
  constructor(readonly reason: SessionFailure) {
    super(`Session invalid: ${reason}`);
  }
}

export class UserNotFoundError extends Error {
  override name = 'UserNotFoundError';
}
