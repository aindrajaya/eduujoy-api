import { AiCallError } from './errors';
import { withRetry } from './retry';

function flaky(failures: AiCallError[]): { fn: () => Promise<string>; calls: () => number } {
  let calls = 0;
  return {
    fn: () => {
      const failure = failures[calls];
      calls += 1;
      return failure ? Promise.reject(failure) : Promise.resolve('ok');
    },
    calls: () => calls,
  };
}

describe('withRetry', () => {
  const sleeps: number[] = [];
  const options = {
    retries: 2,
    baseDelayMs: 100,
    sleep: (ms: number) => {
      sleeps.push(ms);
      return Promise.resolve();
    },
    random: () => 0.5,
  };

  beforeEach(() => {
    sleeps.length = 0;
  });

  it('retries retryable failures with exponential delays (jitter fixed at 1.0x here)', async () => {
    const op = flaky([new AiCallError('rate_limited', '429'), new AiCallError('server', '503')]);

    await expect(withRetry(op.fn, options)).resolves.toBe('ok');
    expect(op.calls()).toBe(3);
    expect(sleeps).toEqual([100, 200]);
  });

  it('gives up after the configured retries', async () => {
    const op = flaky([1, 2, 3].map(() => new AiCallError('timeout', 't')));

    await expect(withRetry(op.fn, options)).rejects.toMatchObject({ failure: 'timeout' });
    expect(op.calls()).toBe(3);
  });

  it.each(['bad_request', 'invalid_output', 'refused', 'billing', 'auth'] as const)('never retries %s', async (failure) => {
    const op = flaky([new AiCallError(failure, 'x')]);

    await expect(withRetry(op.fn, options)).rejects.toMatchObject({ failure });
    expect(op.calls()).toBe(1);
  });

  it('does not retry errors that are not AiCallError', async () => {
    let calls = 0;
    const fn = (): Promise<never> => {
      calls += 1;
      return Promise.reject(new TypeError('bug'));
    };

    await expect(withRetry(fn, options)).rejects.toBeInstanceOf(TypeError);
    expect(calls).toBe(1);
  });
});
