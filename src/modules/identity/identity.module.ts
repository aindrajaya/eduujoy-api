import { Module } from '@nestjs/common';
import { AppConfig } from '../../shared/config';
import { BillingModule } from '../billing/billing.module';
import { GetMe } from './application/get-me.query';
import { LoginWithPassword } from './application/login.usecase';
import { Logout } from './application/logout.usecase';
import { IDENTITY_CLOCK, PASSWORD_HASHER, SECRET_HASHER } from './application/ports/crypto';
import { LOGIN_ATTEMPT_REPOSITORY } from './application/ports/login-attempt.repository';
import { SESSION_REPOSITORY } from './application/ports/session.repository';
import { USER_REPOSITORY } from './application/ports/user.repository';
import { RefreshSession } from './application/refresh.usecase';
import { RegisterUser } from './application/register.usecase';
import { SessionIssuer } from './application/session-issuer';
import { Argon2PasswordHasher } from './infrastructure/argon2-password.hasher';
import { DrizzleLoginAttemptRepository } from './infrastructure/drizzle-login-attempt.repository';
import { DrizzleSessionRepository } from './infrastructure/drizzle-session.repository';
import { DrizzleUserRepository } from './infrastructure/drizzle-user.repository';
import { HmacSecretHasher } from './infrastructure/hmac-secret.hasher';
import { AuthController } from './interface/auth.controller';

@Module({
  imports: [BillingModule],
  controllers: [AuthController],
  providers: [
    RegisterUser,
    LoginWithPassword,
    RefreshSession,
    Logout,
    GetMe,
    SessionIssuer,
    { provide: USER_REPOSITORY, useClass: DrizzleUserRepository },
    { provide: SESSION_REPOSITORY, useClass: DrizzleSessionRepository },
    { provide: LOGIN_ATTEMPT_REPOSITORY, useClass: DrizzleLoginAttemptRepository },
    { provide: PASSWORD_HASHER, useFactory: () => new Argon2PasswordHasher() },
    {
      provide: SECRET_HASHER,
      inject: [AppConfig],
      useFactory: (config: AppConfig) => new HmacSecretHasher(config.env.REFRESH_TOKEN_PEPPER),
    },
    { provide: IDENTITY_CLOCK, useValue: () => new Date() },
  ],
  exports: [SessionIssuer, USER_REPOSITORY],
})
export class IdentityModule {}
