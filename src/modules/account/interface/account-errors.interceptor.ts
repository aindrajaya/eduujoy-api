import { type CallHandler, type ExecutionContext, Injectable, type NestInterceptor } from '@nestjs/common';
import { catchError, type Observable, throwError } from 'rxjs';
import { ProblemException } from '../../../shared/common/problem';
import { ReauthRequiredError, SessionGoneError } from '../application/errors';

export function toAccountProblem(error: unknown): unknown {
  if (error instanceof ReauthRequiredError) {
    return new ProblemException(401, 'REAUTH_REQUIRED', 'Sign in again', { detail: 'Deleting the account needs a sign-in within the last 10 minutes.' });
  }
  if (error instanceof SessionGoneError) return new ProblemException(401, 'UNAUTHENTICATED', 'Not signed in');
  return error;
}

@Injectable()
export class AccountErrorsInterceptor implements NestInterceptor {
  intercept(_context: ExecutionContext, next: CallHandler): Observable<unknown> {
    return next.handle().pipe(catchError((error: unknown) => throwError(() => toAccountProblem(error))));
  }
}
