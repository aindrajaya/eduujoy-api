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

/**
 * 503 AI_BUDGET_EXCEEDED (contract `BudgetExceeded`, 0.2.1-v0) with its `Retry-After` response header:
 * whole seconds until the next UTC midnight, when the daily budget resets. For cold-topic AI routes.
 */
export function ApiBudgetExceeded(): MethodDecorator {
  return ApiResponse({
    status: 503,
    description: 'Daily AI budget reached for cold topics (code AI_BUDGET_EXCEEDED).',
    headers: {
      'Retry-After': {
        description: 'Whole seconds until the next UTC midnight, when the daily budget resets (at least 1).',
        schema: { type: 'integer', minimum: 1 },
      },
    },
    content: { 'application/problem+json': { schema: schemaRef('Problem') } },
  });
}

/** Contract `ServiceUnavailable` (0.4.0-v0): 503 SERVICE_UNAVAILABLE with Retry-After. */
export function ApiServiceUnavailable(): MethodDecorator {
  return ApiResponse({
    status: 503,
    description: 'A dependency is briefly unavailable (code SERVICE_UNAVAILABLE). Retry after the given wait.',
    headers: {
      'Retry-After': {
        description: 'Whole seconds to wait before retrying (30 for topic resolve). Exposed to allow-listed origins via CORS.',
        schema: { type: 'integer', minimum: 1 },
      },
    },
    content: { 'application/problem+json': { schema: schemaRef('Problem') } },
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

/** Contract `IdempotencyKey` (required) or `IdempotencyKeyOptional`; read with `@IdempotencyKey()`. */
export const ApiIdempotencyKeyHeader = (required = false): MethodDecorator & ClassDecorator =>
  ApiHeader({
    name: 'Idempotency-Key',
    required,
    description: required ? 'Retries of the same request reuse it.' : 'Optional; when sent, retries of the same request reuse it (see the operation).',
    schema: { type: 'string', minLength: 8, maxLength: 128 },
  });

export const ApiAccessCookieAuth = (): MethodDecorator & ClassDecorator => ApiSecurity('cookieAuth');
export const ApiRefreshCookieAuth = (): MethodDecorator & ClassDecorator => ApiSecurity('refreshCookie');

export const SESSION_COOKIES_HEADER = {
  'Set-Cookie': { description: 'Sets or clears `ej_at` and `ej_rt`.', schema: { type: 'string' } },
};
