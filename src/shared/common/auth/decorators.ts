import { createParamDecorator, type ExecutionContext, SetMetadata } from '@nestjs/common';
import { type Request } from 'express';
import { ProblemException } from '../problem/problem';
import { type AccessClaims, type AuthRole } from './access-token.service';

export const IS_PUBLIC = 'auth:public';
export const ROLES = 'auth:roles';
export const SKIP_CSRF = 'auth:skip-csrf';

/** Skips JwtAuthGuard. */
export const Public = (): MethodDecorator & ClassDecorator => SetMetadata(IS_PUBLIC, true);
/** Requires at least one of the roles (RolesGuard). */
export const Roles = (...roles: AuthRole[]): MethodDecorator & ClassDecorator => SetMetadata(ROLES, roles);
/** Skips CsrfGuard; only for signature-verified server-to-server routes such as webhooks. */
export const SkipCsrf = (): MethodDecorator & ClassDecorator => SetMetadata(SKIP_CSRF, true);

export type AuthUser = AccessClaims;

export const CurrentUser = createParamDecorator((_data: unknown, ctx: ExecutionContext): AuthUser => {
  const user = ctx.switchToHttp().getRequest<Request>().user;
  if (!user) throw new ProblemException(401, 'UNAUTHENTICATED', 'Not signed in');
  return user;
});
