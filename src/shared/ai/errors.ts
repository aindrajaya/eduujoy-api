export type AiFailure = 'rate_limited' | 'server' | 'timeout' | 'refused' | 'invalid_output' | 'bad_request' | 'auth';

/** Normalised provider failure. Only rate limits, server errors and timeouts are worth retrying. */
export class AiCallError extends Error {
  override name = 'AiCallError';
  constructor(
    readonly failure: AiFailure,
    message: string,
    readonly status?: number,
  ) {
    super(message);
  }

  get retryable(): boolean {
    return this.failure === 'rate_limited' || this.failure === 'server' || this.failure === 'timeout';
  }
}

/** Raised by the budget guard when daily AI spend has passed AI_DAILY_BUDGET_USD (PRD-API §5). */
export class AiBudgetExceededError extends Error {
  override name = 'AiBudgetExceededError';
  constructor(
    readonly spentUsd: number,
    readonly budgetUsd: number,
  ) {
    super(`Daily AI budget reached: $${spentUsd.toFixed(2)} of $${budgetUsd.toFixed(2)}`);
  }
}

export function classifyStatus(status: number | undefined): AiFailure {
  if (status === 429) return 'rate_limited';
  if (status === 401 || status === 403) return 'auth';
  if (status === 408) return 'timeout';
  if (status !== undefined && status >= 500) return 'server';
  return 'bad_request';
}
