import { type CanActivate, type ExecutionContext, Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { type Request } from 'express';
import { AppConfig } from '../../config';
import { ProblemException } from '../problem/problem';
import { AccessTokenService, type AuthRole } from './access-token.service';
import { IS_PUBLIC, ROLES, SKIP_CSRF } from './decorators';
import { ACCESS_COOKIE } from './session-cookies';

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);
export const CSRF_HEADER_VALUE = 'eduujoy';

/** Unsafe methods need an allow-listed Origin and `X-Requested-With: eduujoy` (PRD-API §6). */
@Injectable()
export class CsrfGuard implements CanActivate {
  private readonly allowed: Set<string>;

  constructor(
    private readonly reflector: Reflector,
    config: AppConfig,
  ) {
    this.allowed = new Set(config.env.APP_ORIGIN);
  }

  canActivate(context: ExecutionContext): boolean {
    if (context.getType() !== 'http') return true;
    const req = context.switchToHttp().getRequest<Request>();
    if (SAFE_METHODS.has(req.method)) return true;
    if (this.reflector.getAllAndOverride<boolean>(SKIP_CSRF, [context.getHandler(), context.getClass()])) return true;

    const origin = req.headers.origin;
    const requestedWith = req.headers['x-requested-with'];
    if (origin !== undefined && this.allowed.has(origin) && requestedWith === CSRF_HEADER_VALUE) return true;
    throw new ProblemException(403, 'CSRF_REJECTED', 'Cross-site request rejected');
  }
}

/** Reads the `ej_at` cookie; routes marked @Public() skip it. */
@Injectable()
export class JwtAuthGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly tokens: AccessTokenService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    if (context.getType() !== 'http') return true;
    if (this.reflector.getAllAndOverride<boolean>(IS_PUBLIC, [context.getHandler(), context.getClass()])) return true;

    const req = context.switchToHttp().getRequest<Request>();
    const cookies = req.cookies as Record<string, unknown> | undefined;
    const token = cookies?.[ACCESS_COOKIE];
    const claims = typeof token === 'string' ? await this.tokens.verify(token) : null;
    if (!claims) throw new ProblemException(401, 'UNAUTHENTICATED', 'Not signed in');
    req.user = claims;
    return true;
  }
}

@Injectable()
export class RolesGuard implements CanActivate {
  constructor(private readonly reflector: Reflector) {}

  canActivate(context: ExecutionContext): boolean {
    const required = this.reflector.getAllAndOverride<AuthRole[] | undefined>(ROLES, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (!required || required.length === 0) return true;
    const user = context.switchToHttp().getRequest<Request>().user;
    if (user?.roles.some((role) => required.includes(role))) return true;
    throw new ProblemException(403, 'FORBIDDEN', 'Forbidden');
  }
}
