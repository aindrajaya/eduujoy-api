import { Inject, Injectable, Logger } from '@nestjs/common';
import { AiBudgetGuard } from '../../../shared/ai';
import { type EventBus } from '../../../shared/events';
import { JobQueue } from '../../../shared/jobs';
import { type PlacementComputed } from '../../assessment/domain/events/placement-computed.event';
import { GetBudgetScopeQuery } from '../../billing/application/get-budget-scope.query';
import { type Stage } from '../domain';
import { DISCOVER_RESOURCES_JOB, type DiscoverPayload } from './jobs';
import { type Clock, DISCOVERY_CLOCK, DISCOVERY_REPOSITORY, type DiscoveryRepository } from './ports/discovery.repository';

export type DiscoveryRequestOutcome = 'fresh' | 'queued' | 'over_budget';

/**
 * PlacementComputed → `discover-resources` when the topic and stage pool is missing or expired
 * (PRD-API §5). Pools are shared across learners; a cold discovery checks the daily AI budget first.
 */
@Injectable()
export class RequestDiscovery {
  private readonly logger = new Logger(RequestDiscovery.name);

  constructor(
    @Inject(DISCOVERY_REPOSITORY) private readonly repo: DiscoveryRepository,
    private readonly queue: JobQueue,
    private readonly budget: AiBudgetGuard,
    private readonly scopes: GetBudgetScopeQuery,
    @Inject(DISCOVERY_CLOCK) private readonly clock: Clock,
  ) {}

  /** PlacementComputed → discover-resources when the topic + stage pool is missing or expired (PRD-API §5). */
  listen(bus: EventBus): void {
    bus.on<PlacementComputed>('PlacementComputed', (e) => this.execute({ topicId: e.topicId, stage: e.stage, userId: e.userId }));
  }

  async execute(input: { topicId: string; stage: Stage; userId?: string }): Promise<DiscoveryRequestOutcome> {
    const latest = await this.repo.latestPool(input.topicId, input.stage);
    if (latest && latest.expiresAt > this.clock()) return 'fresh';

    // A shared pool is charged to the scope of the learner whose placement triggered it (D1).
    const budgetScope = input.userId ? await this.scopes.execute(input.userId) : 'free';
    const budget = await this.budget.status(budgetScope);
    if (budget.exceeded) {
      this.logger.warn({ topicId: input.topicId, stage: input.stage, budgetScope }, 'Cold discovery skipped: daily AI budget reached');
      return 'over_budget';
    }
    const poolVersion = (latest?.poolVersion ?? 0) + 1;
    const payload: DiscoverPayload = { topicId: input.topicId, stage: input.stage, poolVersion, budgetScope };
    await this.queue.enqueue({
      type: DISCOVER_RESOURCES_JOB,
      idempotencyKey: `${input.topicId}:${input.stage}:${poolVersion}`,
      payload,
      userId: input.userId ?? null,
      maxAttempts: 3,
    });
    return 'queued';
  }
}
