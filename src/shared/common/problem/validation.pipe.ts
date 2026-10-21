import { HttpStatus, ValidationPipe } from '@nestjs/common';
import { flattenValidationErrors, ProblemException } from './problem';

/** Global DTO validation (PRD-API §7): strip-and-reject unknown fields, no implicit conversion. */
export function createValidationPipe(): ValidationPipe {
  return new ValidationPipe({
    whitelist: true,
    forbidNonWhitelisted: true,
    transform: true,
    transformOptions: { enableImplicitConversion: false },
    validationError: { target: false, value: false },
    exceptionFactory: (errors) =>
      new ProblemException(HttpStatus.BAD_REQUEST, 'VALIDATION_FAILED', 'Validation failed', {
        errors: flattenValidationErrors(errors),
      }),
  });
}
