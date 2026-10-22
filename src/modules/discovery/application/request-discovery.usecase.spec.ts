import { type AiBudgetGuard, type BudgetScope } from '../../../shared/ai';
import { type EnqueueRequest, type JobQueue } from '../../../shared/jobs';
import { type GetBudgetScopeQuery } from '../../billing/application/get-budget-scope.query';
import { type DiscoveryRepository } from './ports/discovery.repository';
import { RequestDiscovery } from './request-discovery.usecase';

function setup(scope: 'free' | 'paid', exceeded: Partial<Record<BudgetScope, boolean>>) {
  const queued: EnqueueRequest[] = [];
  const repo = { latestPool: () => Promise.resolve(null) } as unknown as DiscoveryRepository;
  const queue = { enqueue: (r: EnqueueRequest) => (queued.push(r), Promise.resolve({ job: { id: 'j' }, created: true })) } as unknown as JobQueue;
  const budget = { status: (s: BudgetScope) => Promise.resolve({ exceeded: exceeded[s] ?? false }) } as unknown as AiBudgetGuard;
  const scopes = { execute: () => Promise.resolve(scope) } as unknown as GetBudgetScopeQuery;
  return { queued, request: new RequestDiscovery(repo, queue, budget, scopes, () => new Date('2026-10-30T12:00:00Z')) };
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
});
