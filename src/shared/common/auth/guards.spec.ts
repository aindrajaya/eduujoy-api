import { type ExecutionContext } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { AppConfig } from '../../config';
import { type Env } from '../../config/env';
import { type AccessClaims } from './access-token.service';
import { ROLES, SKIP_CSRF } from './decorators';
import { CsrfGuard, RolesGuard } from './guards';

function context(req: { method?: string; headers?: Record<string, string>; user?: AccessClaims }): ExecutionContext {
  const request = { method: 'POST', headers: {}, ...req };
  return {
    getType: () => 'http',
    getHandler: () => context,
    getClass: () => CsrfGuard,
    switchToHttp: () => ({ getRequest: () => request }),
  } as unknown as ExecutionContext;
}

function reflectorWith(metadata: Record<string, unknown>): Reflector {
  const reflector = new Reflector();
  jest.spyOn(reflector, 'getAllAndOverride').mockImplementation((key: unknown) => metadata[String(key)]);
  return reflector;
}

const config = new AppConfig({ APP_ORIGIN: ['https://eduujoy.aindrajaya.my.id'] } as Env);
const good = { origin: 'https://eduujoy.aindrajaya.my.id', 'x-requested-with': 'eduujoy' };

describe('CsrfGuard', () => {
  const guard = new CsrfGuard(reflectorWith({}), config);

  it('lets safe methods through without headers', () => {
    expect(guard.canActivate(context({ method: 'GET' }))).toBe(true);
  });

  it('accepts an unsafe request with an allowed Origin and X-Requested-With', () => {
    expect(guard.canActivate(context({ headers: good }))).toBe(true);
  });

  it.each([
    ['a missing Origin', { 'x-requested-with': 'eduujoy' }],
    ['a foreign Origin', { ...good, origin: 'https://evil.example' }],
    ['a missing X-Requested-With', { origin: good.origin }],
    ['a wrong X-Requested-With', { ...good, 'x-requested-with': 'XMLHttpRequest' }],
  ])('rejects %s with CSRF_REJECTED', (_label, headers) => {
    expect(() => guard.canActivate(context({ method: 'PATCH', headers }))).toThrow(
      expect.objectContaining({ code: 'CSRF_REJECTED' }) as Error,
    );
  });

  it('can be skipped for signature-verified routes', () => {
    expect(new CsrfGuard(reflectorWith({ [SKIP_CSRF]: true }), config).canActivate(context({}))).toBe(true);
  });
});

describe('RolesGuard', () => {
  const user = (roles: AccessClaims['roles']): AccessClaims => ({ userId: 'u', sessionId: 's', roles, plan: 'free' });

  it('allows routes without @Roles', () => {
    expect(new RolesGuard(reflectorWith({})).canActivate(context({ user: user(['learner']) }))).toBe(true);
  });

  it('allows a user holding one of the required roles', () => {
    const guard = new RolesGuard(reflectorWith({ [ROLES]: ['reviewer', 'admin'] }));

    expect(guard.canActivate(context({ user: user(['learner', 'reviewer']) }))).toBe(true);
  });

  it('forbids a user without the role', () => {
    const guard = new RolesGuard(reflectorWith({ [ROLES]: ['admin'] }));

    expect(() => guard.canActivate(context({ user: user(['learner']) }))).toThrow(
      expect.objectContaining({ code: 'FORBIDDEN' }) as Error,
    );
  });
});
