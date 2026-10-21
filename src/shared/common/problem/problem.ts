import { HttpException, HttpStatus } from '@nestjs/common';
import { ThrottlerException } from '@nestjs/throttler';
import { type ValidationError } from 'class-validator';

/** ProblemCode from the frozen contract. */
export type ProblemCode =
  | 'VALIDATION_FAILED'
  | 'UNAUTHENTICATED'
  | 'SESSION_REVOKED'
  // Pending contract approval (docs/status/api.md, Contract change requests, 21 Oct 2026).
  | 'REFRESH_CONCURRENT'
  | 'FORBIDDEN'
  | 'NOT_FOUND'
  | 'CONFLICT'
  | 'EMAIL_TAKEN'
  | 'IDEMPOTENCY_MISMATCH'
  | 'QUOTA_EXCEEDED'
  | 'RATE_LIMITED'
  | 'AI_BUDGET_EXCEEDED'
  | 'NO_REPLACEMENT'
  | 'CSRF_REJECTED'
  | 'INTERNAL';

export interface FieldError {
  field: string;
  message: string;
}

export interface ProblemBody {
  type: string;
  title: string;
  status: number;
  detail?: string;
  instance?: string;
  code: ProblemCode;
  requestId: string;
  errors?: FieldError[];
}

export interface ProblemOptions {
  detail?: string;
  errors?: FieldError[];
  headers?: Record<string, string>;
}

/** Throw this anywhere to produce an RFC 9457 response with a contract `code`. */
export class ProblemException extends HttpException {
  constructor(
    status: number,
    readonly code: ProblemCode,
    readonly title: string,
    readonly problem: ProblemOptions = {},
  ) {
    super(title, status);
  }
}

export interface ProblemContext {
  baseUrl: string;
  requestId: string;
  instance: string;
}

export interface RenderedProblem {
  status: number;
  headers: Record<string, string>;
  body: ProblemBody;
}

const BY_STATUS: Partial<Record<number, [ProblemCode, string]>> = {
  400: ['VALIDATION_FAILED', 'Invalid request'],
  401: ['UNAUTHENTICATED', 'Not signed in'],
  403: ['FORBIDDEN', 'Forbidden'],
  404: ['NOT_FOUND', 'Not found'],
  409: ['CONFLICT', 'Conflict'],
  429: ['RATE_LIMITED', 'Too many requests'],
};

const CLIENT_ERROR_TITLES: Partial<Record<number, string>> = {
  400: 'Malformed request body',
  413: 'Request body too large',
  415: 'Unsupported media type',
};

/** body-parser and other http-errors raise `{ status, expose: true }` for client mistakes. */
function clientHttpError(value: unknown): number | undefined {
  if (typeof value !== 'object' || value === null) return undefined;
  const { status, expose } = value as { status?: unknown; expose?: unknown };
  return expose === true && typeof status === 'number' && status >= 400 && status < 500 ? status : undefined;
}

export function problemType(baseUrl: string, code: ProblemCode): string {
  return `${baseUrl}/problems/${code.toLowerCase().replaceAll('_', '-')}`;
}

/** Maps any thrown value to a problem; unknown errors become an opaque 500. */
export function toProblem(exception: unknown, ctx: ProblemContext): RenderedProblem {
  let status: number = HttpStatus.INTERNAL_SERVER_ERROR;
  let code: ProblemCode = 'INTERNAL';
  let title = 'Internal server error';
  let options: ProblemOptions = {};

  if (exception instanceof ProblemException) {
    status = exception.getStatus();
    ({ code, title, problem: options } = exception);
  } else if (exception instanceof ThrottlerException) {
    status = HttpStatus.TOO_MANY_REQUESTS;
    [code, title] = ['RATE_LIMITED', 'Too many requests'];
  } else if (clientHttpError(exception) !== undefined) {
    status = clientHttpError(exception) ?? HttpStatus.BAD_REQUEST;
    [code, title] = ['VALIDATION_FAILED', CLIENT_ERROR_TITLES[status] ?? 'Invalid request'];
  } else if (exception instanceof HttpException && exception.getStatus() < 500) {
    status = exception.getStatus();
    // Other 4xx (413, 415, 422, ...) are request problems; keep their own message as the title.
    [code, title] = BY_STATUS[status] ?? ['VALIDATION_FAILED', exception.message];
  }

  const body: ProblemBody = {
    type: problemType(ctx.baseUrl, code),
    title,
    status,
    ...(options.detail === undefined ? {} : { detail: options.detail }),
    code,
    requestId: ctx.requestId,
    instance: ctx.instance,
    ...(options.errors === undefined ? {} : { errors: options.errors }),
  };
  return { status, headers: options.headers ?? {}, body };
}

export function flattenValidationErrors(errors: ValidationError[], prefix = ''): FieldError[] {
  return errors.flatMap((error) => {
    const field = prefix ? `${prefix}.${error.property}` : error.property;
    const message = Object.values(error.constraints ?? {})[0];
    const own = message === undefined ? [] : [{ field, message }];
    return [...own, ...flattenValidationErrors(error.children ?? [], field)];
  });
}
