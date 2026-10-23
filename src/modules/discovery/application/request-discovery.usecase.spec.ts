import { type AiBudgetGuard, type BudgetScope } from '../../../shared/ai';
import { type EnqueueRequest, type JobQueue } from '../../../shared/jobs';
import { type GetBudgetScopeQuery } from '../../billing/application/get-budget-scope.query';
import { type DiscoveryRepository } from './ports/discovery.repository';
import { RequestDiscovery } from './request-discovery.usecase';

function setup(scope: 'free' | 'paid', exceeded: Partial<Record<BudgetScope, boolean>>, triggeredToday: Record<string, number> = {}) {
  const queued: EnqueueRequest[] = [];
  const repo = { latestPool: () => Promise.resolve(null) } as unknown as DiscoveryRepository;
  const queue = {
    enqueue: (r: EnqueueRequest) => (queued.push(r), Promise.resolve({ job: { id: 'j' }, created: true })),
    countForUser: (_type: string, userId: string) => Promise.resolve(triggeredToday[userId] ?? 0),
  } as unknown as JobQueue;
  const budget = { status: (s: BudgetScope) => Promise.resolve({ exceeded: exceeded[s] ?? false }) } as unknown as AiBudgetGuard;
  const scopes = { execute: () => Promise.resolve(scope) } as unknown as GetBudgetScopeQuery;
  return { queued, request: new RequestDiscovery(repo, queue, budget, scopes, () => new Date('2026-10-30T12:00:00Z'), { free: 1, paid: 5 }) };
}

describe('RequestDiscovery budget scopes (D1)', () => {
  const input = { topicId: '11111111-1111-4111-8111-111111111111', stage: 'novice' as const, userId: 'u-1' };

  it("queues a paid learner's discovery as paid even when free spend is at its cap", async () => {
    const t = setup('paid', { free: true });

    await expect(t.request.execute(input)).resolves.toBe('queued');
    expect(t.queued[0]?.payload).toMatchObject({ budgetScope: 'paid' });
  });

  it("skips a free learner's cold discovery once the free budget is spent", async () => {
    const t = setup('free', { free: true });

    await expect(t.request.execute(input)).resolves.toBe('over_budget');
    expect(t.queued).toEqual([]);
  });

  it('charges a discovery with no learner to the free scope', async () => {
    const t = setup('paid', {});

    await t.request.execute({ topicId: input.topicId, stage: 'novice' });
    expect(t.queued[0]?.payload).toMatchObject({ budgetScope: 'free' });
  });

  describe('per-learner daily cap (lead review)', () => {
    it("defers a free learner's second cold discovery of the day", async () => {
      const t = setup('free', {}, { 'u-1': 1 });

      await expect(t.request.execute(input)).resolves.toBe('deferred');
      expect(t.queued).toEqual([]);
    });

    it("defers a paid learner's sixth cold discovery, not the fifth", async () => {
      await expect(setup('paid', {}, { 'u-1': 4 }).request.execute(input)).resolves.toBe('queued');
      await expect(setup('paid', {}, { 'u-1': 5 }).request.execute(input)).resolves.toBe('deferred');
    });

    it('leaves another learner unaffected', async () => {
      const t = setup('free', {}, { 'u-1': 3 });

      await expect(t.request.execute({ ...input, userId: 'u-2' })).resolves.toBe('queued');
    });
  });
});

