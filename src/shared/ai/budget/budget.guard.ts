import { Logger } from '@nestjs/common';
import { AiBudgetExceededError } from '../errors';

export const SPEND_READER = Symbol('SpendReader');

export interface SpendReader {
  /** Total llm_calls cost (US$) since `since`. */
  spentSince(since: Date): Promise<number>;
}

export type WorkKind = 'cold' | 'cached';

export interface BudgetStatus {
  spentUsd: number;
  budgetUsd: number;
  ratio: number;
  exceeded: boolean;
  /** At or over 80% of the budget (the Sentry alert threshold, PRD-API §12). */
  alert: boolean;
}

export const BUDGET_ALERT_RATIO = 0.8;

export function startOfUtcDay(now: Date): Date {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
}

/**
 * PRD-API §5: once today's AI spend reaches AI_DAILY_BUDGET_USD, new cold-topic jobs are rejected;
 * cached-topic work still runs. The day is the UTC calendar day.
 */
export class AiBudgetGuard {
  private readonly logger = new Logger(AiBudgetGuard.name);
  private alertedDay: string | null = null;

  constructor(
    private readonly spend: SpendReader,
    private readonly budgetUsd: number,
    private readonly clock: () => Date = () => new Date(),
  ) {}

  async status(): Promise<BudgetStatus> {
    const now = this.clock();
    const spentUsd = await this.spend.spentSince(startOfUtcDay(now));
    const ratio = spentUsd / this.budgetUsd;
    const status = { spentUsd, budgetUsd: this.budgetUsd, ratio, exceeded: ratio >= 1, alert: ratio >= BUDGET_ALERT_RATIO };
    const day = startOfUtcDay(now).toISOString();
    if (status.alert && this.alertedDay !== day) {
      this.alertedDay = day;
      this.logger.warn({ spentUsd, budgetUsd: this.budgetUsd }, 'Daily AI spend passed 80% of AI_DAILY_BUDGET_USD');
    }
    return status;
  }

  /** Throws AiBudgetExceededError for cold work once the budget is spent; cached work always passes. */
  async assertCanStart(kind: WorkKind): Promise<void> {
    if (kind === 'cached') return;
    const { exceeded, spentUsd } = await this.status();
    if (exceeded) throw new AiBudgetExceededError(spentUsd, this.budgetUsd);
  }
}
