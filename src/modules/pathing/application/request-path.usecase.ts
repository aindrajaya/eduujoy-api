import { createHash, randomUUID } from 'node:crypto';
import { Inject, Injectable, Logger } from '@nestjs/common';
import { AiBudgetGuard } from '../../../shared/ai';
import { ProblemException } from '../../../shared/common/problem/problem';
import { UnitOfWork } from '../../../shared/events';
import { JobQueue } from '../../../shared/jobs';
import { GetPlacementForPathQuery } from '../../assessment/application/get-placement-for-path.query';
import { QuotaExceededError } from '../../billing/application/errors';
import { GetBudgetScopeQuery } from '../../billing/application/get-budget-scope.query';
import { RefundPath } from '../../billing/application/refund-path.usecase';
import { ReservePath } from '../../billing/application/reserve-path.usecase';
import { ServedCardsQuery } from '../../discovery/application/served-cards.query';
import { BANDS, type Stage, targetStage } from '../domain';
import { GENERATE_PATH_JOB, type GeneratePathInput } from './jobs';
import { PATH_REPOSITORY, type PathReplay, type PathRepository } from './ports/path.repository';

/** PRD-API §6: at most 5 path generations per learner per hour. */
export const PATHS_PER_HOUR = 5;

export interface RequestPathInput {
  userId: string;
  idempotencyKey: string;
  placementId: string;
  goal?: string;
  weeklyHours?: number;
}

export type JobAcceptedView = PathReplay['response'];

/**
 * POST /v1/paths (plan §1.1). Checks run before any charge, so a 404, 429 or 503 costs the learner
 * nothing; the charge is tied to a path id made here, and given back if the path can't be saved.
 */
@Injectable()
export class RequestPath {
  private readonly logger = new Logger(RequestPath.name);

  constructor(
    @Inject(PATH_REPOSITORY) private readonly repo: PathRepository,
    private readonly placements: GetPlacementForPathQuery,
    private readonly scopes: GetBudgetScopeQuery,
    private readonly budget: AiBudgetGuard,
    private readonly served: ServedCardsQuery,
    private readonly reserve: ReservePath,
    private readonly refunds: RefundPath,
    private readonly queue: JobQueue,
    private readonly uow: UnitOfWork,
  ) {}

  async execute(input: RequestPathInput): Promise<JobAcceptedView> {
    const requestHash = createHash('sha256')
      .update(JSON.stringify([input.placementId, input.goal ?? null, input.weeklyHours ?? null]))
      .digest('hex');
    const replay = await this.repo.findReplay(input.userId, input.idempotencyKey);
    if (replay) {
      if (replay.requestHash !== requestHash) throw mismatch();
      return replay.response;
    }

    const placement = await this.placements.execute(input.userId, input.placementId);
    if (!placement) throw new ProblemException(404, 'NOT_FOUND', 'Not found', { detail: 'Placement not found.' });

    // A second request for the same placement (another key) gets the path already being built.
    const live = await this.repo.findLiveForPlacement(input.userId, placement.id);
    if (live?.jobId) return this.remember(input, requestHash, live.id, live.jobId);

    const since = new Date(Date.now() - 3600_000);
    if ((await this.repo.countCreatedSince(input.userId, since)) >= PATHS_PER_HOUR) {
      throw new ProblemException(429, 'RATE_LIMITED', 'Too many requests', { detail: `At most ${PATHS_PER_HOUR} paths an hour.`, headers: { 'Retry-After': '3600' } });
    }

    const target = targetStage(placement.stage);
    const stages: Stage[] = target === placement.stage ? [placement.stage] : [placement.stage, target];
    const predicted = await this.scopes.execute(input.userId);
    // A path on ready pools is cheap (cached); any missing pool means cold discovery too.
    const ready = await Promise.all(stages.map(async (s) => (await this.served.pool(placement.topicId, s)).pool));
    const cold = ready.some((p) => !p || p.status === 'analysing' || p.expiresAt.getTime() <= Date.now());
    await this.budget.assertCanStart(cold ? 'cold' : 'cached', predicted);

    const pathId = randomUUID();
    let charge: 'plan' | 'credit';
    try {
      charge = await this.reserve.execute(input.userId, pathId);
    } catch (error) {
      if (error instanceof QuotaExceededError) {
        throw new ProblemException(402, 'QUOTA_EXCEEDED', 'Path quota exceeded', { detail: `Your ${error.monthlyPaths} paths this period and your credits are used up.` });
      }
      throw error;
    }
    // A credit is paid traffic; the plan allowance is paid on a subscription and free otherwise (D1).
    const budgetScope = charge === 'credit' ? 'paid' : predicted;
    const weeklyHours = input.weeklyHours ?? placement.weeklyHours;
    const payload: GeneratePathInput = { pathId, topicId: placement.topicId, stages, budgetScope, formats: placement.preferredFormats };

    let saved: { pathId: string; jobId: string } | 'taken';
    try {
      saved = await this.uow.run(async (tx, scope) => {
        const created = await this.repo.create(tx, {
          id: pathId,
          userId: input.userId,
          topicId: placement.topicId,
          placementId: placement.id,
          from: { stage: placement.stage, bloom: placement.bloom },
          to: { stage: target, bloom: BANDS[target].top },
          goal: input.goal ?? placement.goal,
          weeklyHours,
        });
        if (!created) return 'taken' as const;
        const { job } = await this.queue.enqueue({ type: GENERATE_PATH_JOB, idempotencyKey: `path:${pathId}`, payload, userId: input.userId, maxAttempts: 3 }, { tx, scope });
        await this.repo.setJob(tx, pathId, job.id);
        return { pathId, jobId: job.id };
      });
    } catch (error) {
      await this.refunds.execute(input.userId, pathId, 'generation_failed');
      throw error;
    }
    if (saved === 'taken') {
      // A parallel request for this placement won the race: give this charge back and join that path.
      await this.refunds.execute(input.userId, pathId, 'generation_failed');
      const winner = await this.repo.findLiveForPlacement(input.userId, placement.id);
      if (!winner?.jobId) throw new ProblemException(409, 'CONFLICT', 'Conflict', { detail: 'A path for this placement is being created; try again.' });
      return this.remember(input, requestHash, winner.id, winner.jobId);
    }
    this.logger.log({ pathId, charge, budgetScope, cold }, 'Path requested');
    return this.remember(input, requestHash, saved.pathId, saved.jobId);
  }

  /** Stores the 202 under this key; a lost race on the key returns the stored one (or 409). */
  private async remember(input: RequestPathInput, requestHash: string, pathId: string, jobId: string): Promise<JobAcceptedView> {
    const response: JobAcceptedView = { jobId, status: 'queued', eventsUrl: `/v1/jobs/${jobId}/events` };
    const stored = await this.uow.run((tx) => this.repo.saveReplay(tx, { userId: input.userId, idempotencyKey: input.idempotencyKey, pathId, requestHash, response }));
    if (stored) return response;
    const earlier = await this.repo.findReplay(input.userId, input.idempotencyKey);
    if (!earlier || earlier.requestHash !== requestHash) throw mismatch();
    return earlier.response;
  }
}

function mismatch(): ProblemException {
  return new ProblemException(409, 'IDEMPOTENCY_MISMATCH', 'Idempotency key reused', { detail: 'This Idempotency-Key was used with a different request.' });
}
