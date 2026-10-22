import { type CallHandler, type ExecutionContext, Injectable, type NestInterceptor } from '@nestjs/common';
import { catchError, type Observable, throwError } from 'rxjs';
import { ProblemException } from '../../../shared/common/problem';
import { WebhookSignatureError } from '../application/receive-webhook.usecase';

export function toBillingProblem(error: unknown): unknown {
  // No detail: a caller probing the webhook learns nothing about why the signature failed.
  if (error instanceof WebhookSignatureError) return new ProblemException(401, 'UNAUTHENTICATED', 'Invalid signature');
  return error;
}

@Injectable()
export class BillingErrorsInterceptor implements NestInterceptor {
  intercept(_context: ExecutionContext, next: CallHandler): Observable<unknown> {
    return next.handle().pipe(catchError((error: unknown) => throwError(() => toBillingProblem(error))));
  }
}
