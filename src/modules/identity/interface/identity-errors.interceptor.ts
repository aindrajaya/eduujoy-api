import { type CallHandler, type ExecutionContext, Injectable, type NestInterceptor } from '@nestjs/common';
import { catchError, type Observable, throwError } from 'rxjs';
import { ProblemException } from '../../../shared/common/problem';
import {
  AccountLockedError,
  EmailTakenError,
  InvalidCredentialsError,
  InvalidPasswordError,
  SessionInvalidError,
  UserNotFoundError,
} from '../application/errors';

/** Maps identity application errors to contract problems; anything else passes through. */
export function toIdentityProblem(error: unknown): unknown {
  if (error instanceof EmailTakenError) return new ProblemException(409, 'EMAIL_TAKEN', 'Email already registered');
  if (error instanceof InvalidPasswordError) {
    return new ProblemException(400, 'VALIDATION_FAILED', 'Validation failed', {
      errors: [{ field: 'password', message: error.message }],
    });
  }
  if (error instanceof InvalidCredentialsError) {
    return new ProblemException(401, 'UNAUTHENTICATED', 'Invalid email or password');
  }
  if (error instanceof AccountLockedError) {
    return new ProblemException(429, 'RATE_LIMITED', 'Too many failed sign-in attempts', {
      detail: 'Try again later or sign in with Google.',
      headers: { 'Retry-After': String(error.retryAfterSeconds) },
    });
  }
  if (error instanceof SessionInvalidError) {
    return error.reason === 'reuse'
      ? new ProblemException(401, 'SESSION_REVOKED', 'Session revoked', {
          detail: 'This sign-in was used elsewhere, so all its sessions were signed out.',
        })
      : new ProblemException(401, 'UNAUTHENTICATED', 'Session expired');
  }
  if (error instanceof UserNotFoundError) return new ProblemException(401, 'UNAUTHENTICATED', 'Not signed in');
  return error;
}

@Injectable()
export class IdentityErrorsInterceptor implements NestInterceptor {
  intercept(_context: ExecutionContext, next: CallHandler): Observable<unknown> {
    return next.handle().pipe(catchError((error: unknown) => throwError(() => toIdentityProblem(error))));
  }
}
