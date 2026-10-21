import { createParamDecorator, type ExecutionContext, HttpStatus } from '@nestjs/common';
import { type Request } from 'express';
import { ProblemException } from '../problem';

/** Contract `IdempotencyKey` / `IdempotencyKeyOptional`: 8–128 characters. */
export const IDEMPOTENCY_KEY_BOUNDS = { min: 8, max: 128 } as const;

/** Reads and bounds-checks `Idempotency-Key`; undefined when absent and optional. */
export function readIdempotencyKey(value: string | string[] | undefined, required: boolean): string | undefined {
  if (value === undefined && !required) return undefined;
  const key = Array.isArray(value) ? undefined : value;
  if (key === undefined || key.length < IDEMPOTENCY_KEY_BOUNDS.min || key.length > IDEMPOTENCY_KEY_BOUNDS.max) {
    throw new ProblemException(HttpStatus.BAD_REQUEST, 'VALIDATION_FAILED', 'Validation failed', {
      errors: [
        {
          field: 'Idempotency-Key',
          message: `${required ? 'required; ' : ''}must be ${IDEMPOTENCY_KEY_BOUNDS.min}–${IDEMPOTENCY_KEY_BOUNDS.max} characters`,
        },
      ],
    });
  }
  return key;
}

/** `@IdempotencyKey()` for the optional header; `@IdempotencyKey({ required: true })` otherwise. */
export const IdempotencyKey = createParamDecorator((options: { required?: boolean } | undefined, ctx: ExecutionContext): string | undefined =>
  readIdempotencyKey(ctx.switchToHttp().getRequest<Request>().headers['idempotency-key'], options?.required ?? false),
);
