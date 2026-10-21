import { type CallHandler, type ExecutionContext, Injectable, type NestInterceptor } from '@nestjs/common';
import { catchError, type Observable, throwError } from 'rxjs';
import { ProblemException } from '../../../shared/common/problem';
import { DiagnosticConflictError, DiagnosticNotFoundError, TopicNotFoundError } from '../application/errors';

export function toAssessmentProblem(error: unknown): unknown {
  if (error instanceof TopicNotFoundError) return new ProblemException(404, 'NOT_FOUND', 'Topic not found');
  if (error instanceof DiagnosticNotFoundError) return new ProblemException(404, 'NOT_FOUND', 'Diagnostic not found');
  if (error instanceof DiagnosticConflictError) {
    return new ProblemException(409, 'CONFLICT', 'Diagnostic state conflict', { detail: error.message });
  }
  return error;
}

@Injectable()
export class AssessmentErrorsInterceptor implements NestInterceptor {
  intercept(_context: ExecutionContext, next: CallHandler): Observable<unknown> {
    return next.handle().pipe(catchError((error: unknown) => throwError(() => toAssessmentProblem(error))));
  }
}
