import { Logger } from '@nestjs/common';
import { AiBudgetExceededError } from '../errors';
import { AiBudgetGuard, type SpendReader, startOfUtcDay } from './budget.guard';

class FakeSpend implements SpendReader {
  spent = 0;
  calls: Date[] = [];
  spentSince(since: Date): Promise<number> {
    this.calls.push(since);
    return Promise.resolve(this.spent);
  }
}

describe('AiBudgetGuard', () => {
  let now: Date;
  let spend: FakeSpend;
  let guard: AiBudgetGuard;
  const warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);

  beforeEach(() => {
    now = new Date('2026-10-21T23:30:00+07:00');
    spend = new FakeSpend();
    guard = new AiBudgetGuard(spend, 5, () => now);
    warn.mockClear();
  });

  it('counts spend from the start of the UTC day', async () => {
    await guard.status();

    expect(spend.calls[0]).toEqual(new Date('2026-10-21T00:00:00Z'));
    expect(startOfUtcDay(new Date('2026-10-22T00:30:00+07:00'))).toEqual(new Date('2026-10-21T00:00:00Z'));
  });

  it('lets cold work start below the budget', async () => {
    spend.spent = 4.99;

    await expect(guard.assertCanStart('cold')).resolves.toBeUndefined();
  });

  it('rejects cold work once the budget is spent', async () => {
    spend.spent = 5;

    await expect(guard.assertCanStart('cold')).rejects.toBeInstanceOf(AiBudgetExceededError);
    await expect(guard.assertCanStart('cold')).rejects.toMatchObject({ spentUsd: 5, budgetUsd: 5 });
  });

  it('always lets cached-topic work run, without even reading spend', async () => {
    spend.spent = 50;

    await expect(guard.assertCanStart('cached')).resolves.toBeUndefined();
    expect(spend.calls).toHaveLength(0);
  });

  it('warns once per UTC day when spend passes 80%', async () => {
    spend.spent = 4;
    await guard.status();
    await guard.status();
    expect(warn).toHaveBeenCalledTimes(1);

    now = new Date('2026-10-22T12:00:00Z');
    await guard.status();
    expect(warn).toHaveBeenCalledTimes(2);
  });

  it('reports the ratio and flags', async () => {
    spend.spent = 4.5;

    await expect(guard.status()).resolves.toEqual({ spentUsd: 4.5, budgetUsd: 5, ratio: 0.9, exceeded: false, alert: true });
  });
});
