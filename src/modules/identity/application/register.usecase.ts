import { Inject, Injectable } from '@nestjs/common';
import { normalizeEmail } from '../domain/email';
import { checkPassword } from '../domain/password-policy';
import { DEFAULT_ROLES } from '../domain/role';
import { EmailTakenError, InvalidPasswordError } from './errors';
import { PASSWORD_HASHER, type PasswordHasher } from './ports/crypto';
import { DuplicateUserError, USER_REPOSITORY, type UserRepository } from './ports/user.repository';
import { type IssuedSession, type RequestMeta, SessionIssuer } from './session-issuer';

export interface RegisterCommand {
  email: string;
  password: string;
  name?: string;
}

@Injectable()
export class RegisterUser {
  constructor(
    @Inject(USER_REPOSITORY) private readonly users: UserRepository,
    @Inject(PASSWORD_HASHER) private readonly hasher: PasswordHasher,
    private readonly issuer: SessionIssuer,
  ) {}

  async execute(command: RegisterCommand, meta: RequestMeta): Promise<IssuedSession> {
    const policy = checkPassword(command.password);
    if (!policy.ok) throw new InvalidPasswordError(policy.reason);

    const email = normalizeEmail(command.email);
    if (await this.users.findByEmail(email)) throw new EmailTakenError();

    const passwordHash = await this.hasher.hash(command.password);
    try {
      const user = await this.users.create({
        email,
        name: command.name?.trim() || null,
        passwordHash,
        googleSub: null,
        emailVerified: false,
        roles: DEFAULT_ROLES,
      });
      return await this.issuer.start(user, meta);
    } catch (error) {
      if (error instanceof DuplicateUserError) throw new EmailTakenError();
      throw error;
    }
  }
}
