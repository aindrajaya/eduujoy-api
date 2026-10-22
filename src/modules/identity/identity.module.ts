import { Module } from '@nestjs/common';
import { AppConfig } from '../../shared/config';
import { BillingModule } from '../billing/billing.module';
import { GetMe } from './application/get-me.query';
import { CompleteGoogleSignIn, StartGoogleSignIn } from './application/google-sign-in.usecase';
import { LoginWithPassword } from './application/login.usecase';
import { Logout } from './application/logout.usecase';
import { IDENTITY_CLOCK, PASSWORD_HASHER, SECRET_HASHER } from './application/ports/crypto';
import { GOOGLE_OAUTH_CLIENT, OAUTH_STATE_STORE } from './application/ports/google';
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
import { GoogleOAuthHttpClient } from './infrastructure/google-oauth.client';
import { HmacSecretHasher } from './infrastructure/hmac-secret.hasher';
import { JoseOAuthStateStore } from './infrastructure/jose-oauth-state.store';
import { ACCOUNT_DATA } from '../../shared/common/account';
import { GetSessionAuthTime } from './application/get-session-auth-time.query';
import { IdentityAccountData } from './infrastructure/identity-account-data';
import { AuthController } from './interface/auth.controller';
import { GoogleAuthController } from './interface/google-auth.controller';

@Module({
  imports: [BillingModule],
  controllers: [AuthController, GoogleAuthController],
  providers: [
    RegisterUser,
    LoginWithPassword,
    RefreshSession,
    Logout,
    GetMe,
    StartGoogleSignIn,
    CompleteGoogleSignIn,
    SessionIssuer,
    GetSessionAuthTime,
    { provide: ACCOUNT_DATA.identity, useClass: IdentityAccountData },
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
    {
      provide: GOOGLE_OAUTH_CLIENT,
      inject: [AppConfig],
      useFactory: ({ env }: AppConfig) =>
        new GoogleOAuthHttpClient({
          clientId: env.GOOGLE_OAUTH_CLIENT_ID,
          clientSecret: env.GOOGLE_OAUTH_CLIENT_SECRET,
          redirectUri: env.GOOGLE_OAUTH_REDIRECT_URI,
        }),
    },
    {
      provide: OAUTH_STATE_STORE,
      inject: [AppConfig],
      useFactory: ({ env }: AppConfig) => new JoseOAuthStateStore(env.JWT_ACCESS_SECRET, env.API_PUBLIC_URL),
    },
  ],
  exports: [SessionIssuer, USER_REPOSITORY, GOOGLE_OAUTH_CLIENT, GetSessionAuthTime, ACCOUNT_DATA.identity],
})
export class IdentityModule {}
