import { Global, Module } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { ThrottlerGuard, ThrottlerModule } from '@nestjs/throttler';
import { AppConfig } from '../../config';
import { AccessTokenService } from './access-token.service';
import { CsrfGuard, JwtAuthGuard, RolesGuard } from './guards';

export const DEFAULT_RATE_LIMIT = { ttl: 60_000, limit: 100 };

/**
 * Global guard chain in PRD-API §6 order: throttle, CSRF, JWT, roles. Policy and entitlement
 * guards are added by the slices that own them (pathing, billing).
 */
@Global()
@Module({
  imports: [ThrottlerModule.forRoot({ throttlers: [{ name: 'default', ...DEFAULT_RATE_LIMIT }] })],
  providers: [
    {
      provide: AccessTokenService,
      inject: [AppConfig],
      useFactory: (config: AppConfig) =>
        new AccessTokenService(config.env.JWT_ACCESS_SECRET, config.env.API_PUBLIC_URL),
    },
    { provide: APP_GUARD, useClass: ThrottlerGuard },
    { provide: APP_GUARD, useClass: CsrfGuard },
    { provide: APP_GUARD, useClass: JwtAuthGuard },
    { provide: APP_GUARD, useClass: RolesGuard },
  ],
  exports: [AccessTokenService],
})
export class AuthKernelModule {}
