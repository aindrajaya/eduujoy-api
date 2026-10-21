import {
  BadRequestException,
  ForbiddenException,
  HttpStatus,
  NotFoundException,
  PayloadTooLargeException,
} from '@nestjs/common';
import { ThrottlerException } from '@nestjs/throttler';
import { type ValidationError } from 'class-validator';
import { AiBudgetExceededError } from '../../ai/errors';
import { flattenValidationErrors, ProblemException, problemType, secondsUntilUtcMidnight, toProblem } from './problem';

const ctx = { baseUrl: 'https://api.example', requestId: 'req-1', instance: '/v1/auth/login' };

describe('problemType', () => {
  it('builds a kebab-case problem URL from the code', () => {
    expect(problemType('https://api.example', 'EMAIL_TAKEN')).toBe('https://api.example/problems/email-taken');
  });
});

describe('toProblem', () => {
  it('renders a ProblemException with its code, detail and field errors', () => {
    const exception = new ProblemException(HttpStatus.CONFLICT, 'EMAIL_TAKEN', 'Email already registered', {
      detail: 'Sign in instead.',
    });

    expect(toProblem(exception, ctx)).toEqual({
      status: 409,
      headers: {},
      body: {
        type: 'https://api.example/problems/email-taken',
        title: 'Email already registered',
        status: 409,
        detail: 'Sign in instead.',
        code: 'EMAIL_TAKEN',
        requestId: 'req-1',
        instance: '/v1/auth/login',
      },
    });
  });

  it('uses a contract-named type slug when given', () => {
    const exception = new ProblemException(503, 'SERVICE_UNAVAILABLE', 'Service not ready', { typeSlug: 'not-ready' });

    expect(toProblem(exception, ctx).body).toMatchObject({
      type: 'https://api.example/problems/not-ready',
      code: 'SERVICE_UNAVAILABLE',
      status: 503,
    });
  });

  it('keeps headers such as Retry-After from a ProblemException', () => {
    const exception = new ProblemException(429, 'RATE_LIMITED', 'Too many attempts', { headers: { 'Retry-After': '900' } });

    expect(toProblem(exception, ctx).headers).toEqual({ 'Retry-After': '900' });
  });

  it.each([
    [new NotFoundException(), 404, 'NOT_FOUND'],
    [new ForbiddenException(), 403, 'FORBIDDEN'],
    [new BadRequestException(), 400, 'VALIDATION_FAILED'],
    [new ThrottlerException(), 429, 'RATE_LIMITED'],
    [new PayloadTooLargeException(), 413, 'VALIDATION_FAILED'],
  ])('maps %s to %i %s', (exception, status, code) => {
    const problem = toProblem(exception, ctx);

    expect(problem.status).toBe(status);
    expect(problem.body.code).toBe(code);
  });

  it('maps body-parser errors to 4xx problems without echoing the parser message', () => {
    const tooLarge = Object.assign(new Error('request entity too large: 262155 > 262144'), {
      status: 413,
      expose: true,
      type: 'entity.too.large',
    });
    const malformed = Object.assign(new SyntaxError('Unexpected token } in JSON at position 9'), {
      status: 400,
      expose: true,
    });

    expect(toProblem(tooLarge, ctx)).toMatchObject({
      status: 413,
      body: { code: 'VALIDATION_FAILED', title: 'Request body too large' },
    });
    expect(toProblem(malformed, ctx).body).toMatchObject({ status: 400, title: 'Malformed request body' });
    expect(JSON.stringify(toProblem(malformed, ctx).body)).not.toContain('Unexpected token');
  });

  it('maps a spent AI budget to 503 AI_BUDGET_EXCEEDED without revealing spend', () => {
    const problem = toProblem(new AiBudgetExceededError(5.12, 5), ctx);

    expect(problem).toMatchObject({ status: 503, body: { code: 'AI_BUDGET_EXCEEDED', title: 'Daily AI budget reached' } });
    expect(JSON.stringify(problem.body)).not.toMatch(/5\.12|\$/);
  });

  it('tells clients to retry at the next UTC midnight, when the budget resets', () => {
    const problem = toProblem(new AiBudgetExceededError(3, 3), { ...ctx, now: new Date('2026-10-21T22:30:00Z') });

    expect(problem.headers).toEqual({ 'Retry-After': String(90 * 60) });
  });

  it('counts down to UTC midnight from any time zone offset, never below 1 second', () => {
    expect(secondsUntilUtcMidnight(new Date('2026-10-22T05:00:00+07:00'))).toBe(2 * 3600);
    expect(secondsUntilUtcMidnight(new Date('2026-10-21T23:59:59.900Z'))).toBe(1);
    expect(secondsUntilUtcMidnight(new Date('2026-10-22T00:00:00Z'))).toBe(86_400);
  });

  it('hides the details of unknown errors behind a generic 500', () => {
    const problem = toProblem(new Error('db password is hunter2'), ctx);

    expect(problem.status).toBe(500);
    expect(problem.body).toMatchObject({ code: 'INTERNAL', title: 'Internal server error' });
    expect(JSON.stringify(problem.body)).not.toContain('hunter2');
  });
});

describe('flattenValidationErrors', () => {
  it('produces dotted field paths with the first message per field', () => {
    const errors: ValidationError[] = [
      { property: 'email', constraints: { isEmail: 'email must be an email', maxLength: 'too long' }, children: [] },
      {
        property: 'answers',
        children: [{ property: '0', children: [{ property: 'itemId', constraints: { isString: 'itemId must be a string' }, children: [] }] }],
      },
    ];

    expect(flattenValidationErrors(errors)).toEqual([
      { field: 'email', message: 'email must be an email' },
      { field: 'answers.0.itemId', message: 'itemId must be a string' },
    ]);
  });
});
