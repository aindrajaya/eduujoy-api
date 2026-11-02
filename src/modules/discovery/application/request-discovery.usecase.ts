import { Inject, Injectable, Logger } from '@nestjs/common';
import { AiBudgetGuard, type BudgetScope } from '../../../shared/ai';
import { type EventBus } from '../../../shared/events';
import { JobQueue } from '../../../shared/jobs';
import { type PlacementComputed } from '../../assessment/domain/events/placement-computed.event';
import { GetBudgetScopeQuery } from '../../billing/application/get-budget-scope.query';
import { type Stage, targetStage } from '../domain';
import { DISCOVER_RESOURCES_JOB, type DiscoverPayload } from './jobs';
import { type Clock, DISCOVERY_CLOCK, DISCOVERY_REPOSITORY, type DiscoveryRepository } from './ports/discovery.repository';

export type DiscoveryRequestOutcome = 'fresh' | 'queued' | 'over_budget' | 'deferred';

/** Per-learner daily caps on cold discoveries their placements trigger (defaults: free 1, paid 5). */
export const DISCOVERY_CAPS = Symbol('DiscoveryCaps');
export type DiscoveryCaps = Record<'free' | 'paid', number>;

/**
 * PlacementComputed → `discover-resources` when the topic and stage pool is missing or expired
 * (PRD-API §5). Pools are shared across learners; a cold discovery checks the daily AI budget first.
 * A path (A9) draws on the placement-stage and the target-stage pools, so a placement pre-warms both,
 * target first, each counting toward the learner's daily cap. A charged path request fetches whatever
 * is still missing, past the cap.
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
    @Inject(DISCOVERY_CAPS) private readonly caps: DiscoveryCaps,
  ) {}

  /** PlacementComputed → discovery for the target stage, then the placement stage (one pool for novices). */
  listen(bus: EventBus): void {
    bus.on<PlacementComputed>('PlacementComputed', (e) => this.forPlacement({ topicId: e.topicId, stage: e.stage, userId: e.userId }));
  }

  /** The target stage first: it feeds the later, larger part of the path (lead, 23 Oct 2026). */
  async forPlacement(input: { topicId: string; stage: Stage; userId: string }): Promise<DiscoveryRequestOutcome[]> {
    const target = targetStage(input.stage);
    const outcomes = [await this.execute({ ...input, stage: target })];
    if (target !== input.stage) outcomes.push(await this.execute(input));
    return outcomes;
  }

  /**
   * `charged`: a path request that has already been charged (A9). It is metered to that charge's scope
   * and is not held to the per-learner cap, which only guards free, unlimited diagnostics.
   */
  async execute(input: { topicId: string; stage: Stage; userId?: string; charged?: { budgetScope: Exclude<BudgetScope, 'operator'> } }): Promise<DiscoveryRequestOutcome> {
    const latest = await this.repo.latestPool(input.topicId, input.stage);
    if (latest && latest.expiresAt > this.clock()) return 'fresh';

    // A shared pool is charged to the scope of the learner whose placement triggered it (D1).
    const budgetScope = input.charged?.budgetScope ?? (input.userId ? await this.scopes.execute(input.userId) : 'free');
    // Diagnostics are free and unlimited: without a cap one learner could drain a whole daily scope.
    // Over the cap the discovery waits for that learner's path request (A9), which charges first.
    if (input.userId && !input.charged) {
      const dayStart = new Date(Date.UTC(this.clock().getUTCFullYear(), this.clock().getUTCMonth(), this.clock().getUTCDate()));
      const triggered = await this.queue.countForUser(DISCOVER_RESOURCES_JOB, input.userId, dayStart);
      if (triggered >= this.caps[budgetScope]) {
        this.logger.log({ topicId: input.topicId, stage: input.stage, budgetScope, triggered, cap: this.caps[budgetScope] }, 'Discovery deferred: per-learner cap');
        return 'deferred';
      }
    }
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
