import { AiCallError } from './errors';

export interface RetryOptions {
  retries: number;
  baseDelayMs: number;
  sleep?: (ms: number) => Promise<void>;
  random?: () => number;
}

const defaultSleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * PRD-API §11: 2 retries on 429/5xx with jitter; never retry 4xx or invalid output.
 * Delay = base x 2^attempt, scaled by full jitter in [0.5, 1.5).
 */
export async function withRetry<T>(fn: () => Promise<T>, options: RetryOptions): Promise<T> {
  const sleep = options.sleep ?? defaultSleep;
  const random = options.random ?? Math.random;
  for (let attempt = 0; ; attempt += 1) {
    try {
      return await fn();
    } catch (error) {
      if (!(error instanceof AiCallError) || !error.retryable || attempt >= options.retries) throw error;
      await sleep(Math.round(options.baseDelayMs * 2 ** attempt * (0.5 + random())));
    }
  }
}
