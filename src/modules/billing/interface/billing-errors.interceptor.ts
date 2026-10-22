import { type CallHandler, type ExecutionContext, Injectable, type NestInterceptor } from '@nestjs/common';
import { catchError, type Observable, throwError } from 'rxjs';
import { ProblemException } from '../../../shared/common/problem';
import { CheckoutUnavailableError, SubscriptionActiveError } from '../application/errors';
import { WebhookSignatureError } from '../application/receive-webhook.usecase';

export function toBillingProblem(error: unknown): unknown {
  // No detail: a caller probing the webhook learns nothing about why the signature failed.
  if (error instanceof WebhookSignatureError) return new ProblemException(401, 'UNAUTHENTICATED', 'Invalid signature');
  if (error instanceof SubscriptionActiveError) {
    return new ProblemException(409, 'CONFLICT', 'Subscription already active', { detail: 'Manage or cancel the current subscription instead.' });
  }
  if (error instanceof CheckoutUnavailableError) {
    return new ProblemException(503, 'SERVICE_UNAVAILABLE', 'Payment provider unavailable', {
      detail: 'Try again in a moment.',
      headers: { 'Retry-After': String(error.retryAfterSeconds) },
    });
  }
  return error;
}

@Injectable()
export class BillingErrorsInterceptor implements NestInterceptor {
  intercept(_context: ExecutionContext, next: CallHandler): Observable<unknown> {
    return next.handle().pipe(catchError((error: unknown) => throwError(() => toBillingProblem(error))));
  }
}
