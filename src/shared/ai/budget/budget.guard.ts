import { Logger } from '@nestjs/common';
import { AiBudgetExceededError } from '../errors';

export const SPEND_READER = Symbol('SpendReader');

/** Whose daily budget a call counts against (D1, user decision 23 Oct 2026). */
export type BudgetScope = 'free' | 'paid' | 'operator';

export interface SpendReader {
  /** Total llm_calls cost (US$) since `since`, in one budget scope. */
  spentSince(since: Date, scope: BudgetScope): Promise<number>;
}

export type WorkKind = 'cold' | 'cached';

/** Daily ceilings: free-tier traffic and paid (subscription or credit) traffic never share one. */
export interface DailyBudgets {
  free: number;
  paid: number;
}

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
 * PRD-API §5: once today's AI spend in a scope reaches its ceiling, new cold-topic jobs in that scope are
 * rejected; cached-topic work still runs. D1 (23 Oct 2026): `free` and `paid` have separate ceilings, so
 * paying users are never blocked by free traffic; `operator` work (pre-generation, smoke) is capped by
 * its own script and counts toward neither. The day is the UTC calendar day.
 */
export class AiBudgetGuard {
  private readonly logger = new Logger(AiBudgetGuard.name);
  private readonly alerted = new Map<BudgetScope, string>();

  constructor(
    private readonly spend: SpendReader,
    private readonly budgets: DailyBudgets,
    private readonly clock: () => Date = () => new Date(),
  ) {}

  async status(scope: Exclude<BudgetScope, 'operator'> = 'free'): Promise<BudgetStatus> {
    const now = this.clock();
    const budgetUsd = this.budgets[scope];
    const spentUsd = await this.spend.spentSince(startOfUtcDay(now), scope);
    const ratio = spentUsd / budgetUsd;
    const status = { spentUsd, budgetUsd, ratio, exceeded: ratio >= 1, alert: ratio >= BUDGET_ALERT_RATIO };
    const day = startOfUtcDay(now).toISOString();
    if (status.alert && this.alerted.get(scope) !== day) {
      this.alerted.set(scope, day);
      this.logger.warn({ scope, spentUsd, budgetUsd }, `Daily ${scope} AI spend passed 80% of its budget`);
    }
    return status;
  }

  /** Throws AiBudgetExceededError for cold work once its scope's budget is spent; cached work and operator scripts always pass. */
  async assertCanStart(kind: WorkKind, scope: BudgetScope = 'free'): Promise<void> {
    if (kind === 'cached' || scope === 'operator') return;
    const { exceeded, spentUsd, budgetUsd } = await this.status(scope);
    if (exceeded) throw new AiBudgetExceededError(spentUsd, budgetUsd);
  }
}
