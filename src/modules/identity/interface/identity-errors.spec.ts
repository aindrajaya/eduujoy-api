import { type ProblemException } from '../../../shared/common/problem';
import { AccountLockedError, EmailTakenError, InvalidCredentialsError, SessionInvalidError } from '../application/errors';
import { toIdentityProblem } from './identity-errors.interceptor';

const asProblem = (error: unknown): ProblemException => toIdentityProblem(error) as ProblemException;

describe('toIdentityProblem', () => {
  it.each([
    [new SessionInvalidError('concurrent'), 409, 'REFRESH_CONCURRENT'],
    [new SessionInvalidError('reuse'), 401, 'SESSION_REVOKED'],
    [new SessionInvalidError('expired'), 401, 'UNAUTHENTICATED'],
    [new SessionInvalidError('missing'), 401, 'UNAUTHENTICATED'],
    [new EmailTakenError(), 409, 'EMAIL_TAKEN'],
    [new InvalidCredentialsError(), 401, 'UNAUTHENTICATED'],
    [new AccountLockedError(60), 429, 'RATE_LIMITED'],
  ])('maps %s to %i %s', (error, status, code) => {
    const problem = asProblem(error);

    expect(problem.getStatus()).toBe(status);
    expect(problem.code).toBe(code);
  });

  it('passes unknown errors through unchanged', () => {
    const error = new Error('boom');

    expect(toIdentityProblem(error)).toBe(error);
  });
});
