import { type CallHandler, type ExecutionContext, Injectable, type NestInterceptor } from '@nestjs/common';
import { catchError, type Observable, throwError } from 'rxjs';
import { ProblemException } from '../../../shared/common/problem';
import { TopicCreateLimitError, TopicSearchUnavailableError, TopicTextInvalidError } from '../application/errors';

export function toCatalogProblem(error: unknown): unknown {
  if (error instanceof TopicTextInvalidError) {
    return new ProblemException(400, 'VALIDATION_FAILED', 'Validation failed', { errors: [{ field: 'text', message: 'must contain letters or digits' }] });
  }
  if (error instanceof TopicCreateLimitError) {
    return new ProblemException(429, 'RATE_LIMITED', 'Too many new topics today', {
      detail: 'You can add more new topics tomorrow; existing topics still resolve.',
      headers: { 'Retry-After': String(error.retryAfterSeconds) },
    });
  }
  if (error instanceof TopicSearchUnavailableError) {
    return new ProblemException(503, 'SERVICE_UNAVAILABLE', 'Topic search is briefly unavailable', {
      detail: 'Try again in a moment.',
      headers: { 'Retry-After': String(error.retryAfterSeconds) },
    });
  }
  return error;
}

@Injectable()
export class CatalogErrorsInterceptor implements NestInterceptor {
  intercept(_context: ExecutionContext, next: CallHandler): Observable<unknown> {
    return next.handle().pipe(catchError((error: unknown) => throwError(() => toCatalogProblem(error))));
  }
}
