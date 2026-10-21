export const LOGIN_ATTEMPT_REPOSITORY = Symbol('LoginAttemptRepository');

export interface LoginAttemptRepository {
  record(email: string, succeeded: boolean, ipHash: string | null): Promise<void>;
  /** Failed attempts after `since` that are newer than the latest success. */
  failuresSince(email: string, since: Date): Promise<Date[]>;
}
