import { Logger } from '@nestjs/common';
import { type BudgetScope, type SpendReader } from '../budget/budget.guard';
import { type LlmCallEntry, type LlmCallRecorder } from './llm-call.recorder';

/**
 * Spend this process made whose llm_calls row failed to persist (a DB blip). The meter is fail-open (an
 * AI call never fails because its row didn't save), so the budget guard adds this tally to today's total:
 * it must never under-count what this process spent (lead review, 22 Oct 2026).
 */
export class UnpersistedSpend {
  private readonly entries: { at: number; costUsd: number; scope: BudgetScope }[] = [];

  add(costUsd: number, at: Date, scope: BudgetScope = 'free'): void {
    this.entries.push({ at: at.getTime(), costUsd, scope });
  }

  get count(): number {
    return this.entries.length;
  }

  totalSince(since: Date, scope?: BudgetScope): number {
    const from = since.getTime();
    return this.entries.reduce((total, e) => (e.at >= from && (scope === undefined || e.scope === scope) ? total + e.costUsd : total), 0);
  }
}

/** Records through `inner`; a failed insert is tallied in UnpersistedSpend, logged, and rethrown. */
export class PersistGuardRecorder implements LlmCallRecorder {
  private readonly logger = new Logger('AiMetering');

  constructor(
    private readonly inner: LlmCallRecorder,
    private readonly unpersisted: UnpersistedSpend,
    private readonly clock: () => Date = () => new Date(),
  ) {}

  async record(entry: LlmCallEntry): Promise<void> {
    try {
      await this.inner.record(entry);
    } catch (error) {
      this.unpersisted.add(entry.costUsd, this.clock(), entry.budgetScope);
      this.logger.error(
        { stage: entry.stage, costUsd: entry.costUsd, scope: entry.budgetScope, unpersistedRows: this.unpersisted.count },
        'llm_calls row not persisted; its cost still counts toward the daily AI budget in this process',
      );
      throw error;
    }
  }
}

/** Persisted spend (llm_calls) plus this process's unpersisted spend. */
export class GuardedSpendReader implements SpendReader {
  constructor(
    private readonly persisted: SpendReader,
    private readonly unpersisted: UnpersistedSpend,
  ) {}

  async spentSince(since: Date, scope: BudgetScope): Promise<number> {
    return (await this.persisted.spentSince(since, scope)) + this.unpersisted.totalSince(since, scope);
  }
}
