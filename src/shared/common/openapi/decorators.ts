import { ApiHeader, ApiResponse, ApiSecurity } from '@nestjs/swagger';
import { schemaRef } from './schemas';

const PROBLEM_DESCRIPTIONS: Record<number, string> = {
  400: 'Validation failed; `errors` maps to form fields.',
  401: 'Not signed in or session expired (code UNAUTHENTICATED).',
  403: 'Not the owner, missing role or CSRF rejected.',
  404: 'Not found (code NOT_FOUND).',
  409: 'Conflict.',
  429: 'Rate limited (code RATE_LIMITED).',
  503: 'Service unavailable.',
};

/** A problem+json response; 400 uses ValidationProblem and 429 documents Retry-After. */
export function ApiProblem(status: number, description = PROBLEM_DESCRIPTIONS[status] ?? 'Error.'): MethodDecorator {
  return ApiResponse({
    status,
    description,
    ...(status === 429 ? { headers: { 'Retry-After': { schema: { type: 'integer' } } } } : {}),
    content: { 'application/problem+json': { schema: schemaRef(status === 400 ? 'ValidationProblem' : 'Problem') } },
  });
}

/** CsrfGuard header required on unsafe methods (PRD-API §6). */
export const ApiCsrfHeader = (): MethodDecorator & ClassDecorator =>
  ApiHeader({
    name: 'X-Requested-With',
    required: true,
    description: 'CSRF guard for unsafe methods.',
    // A one-value enum is OpenAPI 3.1's `const`, which @nestjs/swagger's types don't model.
    schema: { type: 'string', enum: ['eduujoy'] },
  });

export const ApiAccessCookieAuth = (): MethodDecorator & ClassDecorator => ApiSecurity('cookieAuth');
export const ApiRefreshCookieAuth = (): MethodDecorator & ClassDecorator => ApiSecurity('refreshCookie');

export const SESSION_COOKIES_HEADER = {
  'Set-Cookie': { description: 'Sets or clears `ej_at` and `ej_rt`.', schema: { type: 'string' } },
};
