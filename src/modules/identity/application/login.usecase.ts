import { Inject, Injectable } from '@nestjs/common';
import { normalizeEmail } from '../domain/email';
import { lockoutStatus, LOCKOUT_WINDOW_MS } from '../domain/lockout';
import { AccountLockedError, InvalidCredentialsError } from './errors';
import { IDENTITY_CLOCK, type Clock, PASSWORD_HASHER, type PasswordHasher, SECRET_HASHER, type SecretHasher } from './ports/crypto';
import { LOGIN_ATTEMPT_REPOSITORY, type LoginAttemptRepository } from './ports/login-attempt.repository';
import { USER_REPOSITORY, type UserRepository } from './ports/user.repository';
import { type IssuedSession, type RequestMeta, SessionIssuer } from './session-issuer';

export interface LoginCommand {
  email: string;
  password: string;
}

@Injectable()
export class LoginWithPassword {
  constructor(
    @Inject(USER_REPOSITORY) private readonly users: UserRepository,
    @Inject(LOGIN_ATTEMPT_REPOSITORY) private readonly attempts: LoginAttemptRepository,
    @Inject(PASSWORD_HASHER) private readonly hasher: PasswordHasher,
    @Inject(SECRET_HASHER) private readonly secrets: SecretHasher,
    @Inject(IDENTITY_CLOCK) private readonly clock: Clock,
    private readonly issuer: SessionIssuer,
  ) {}

  async execute(command: LoginCommand, meta: RequestMeta): Promise<IssuedSession> {
    const email = normalizeEmail(command.email);
    const now = this.clock();
    const ipHash = meta.ip === null ? null : this.secrets.hashIp(meta.ip);

    // The lock applies per email whether or not the account exists, so it reveals nothing.
    const failures = await this.attempts.failuresSince(email, new Date(now.getTime() - LOCKOUT_WINDOW_MS));
    const lock = lockoutStatus(failures, now);
    if (lock.locked) throw new AccountLockedError(lock.retryAfterSeconds);

    const user = await this.users.findByEmail(email);
    const valid =
      user?.passwordHash != null
        ? await this.hasher.verify(user.passwordHash, command.password)
        : (await this.hasher.verifyDummy(command.password), false);

    await this.attempts.record(email, valid, ipHash);
    if (!valid || !user) throw new InvalidCredentialsError();
    return this.issuer.start(user, meta);
  }
}
