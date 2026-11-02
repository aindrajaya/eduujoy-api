import { Inject, Injectable, Logger } from '@nestjs/common';
import { ProblemException } from '../../../shared/common/problem/problem';
import { ReviewQueue } from '../../../shared/common/review';
import { UnitOfWork } from '../../../shared/events';
import { type JobContext, type JobHandler, JobWaitExpiredError, type JobOutcome, NonRetryableJobError, RescheduleJob } from '../../../shared/jobs';
import { GetTopicProfileQuery } from '../../catalog/application/get-topic-profile.query';
import { type ServedCard } from '../../discovery/application/ports/card.reader';
import { RequestDiscovery } from '../../discovery/application/request-discovery.usecase';
import { ServedCardsQuery } from '../../discovery/application/served-cards.query';
import { PATH_LENGTH_WEEKS, PathGenerated, type Stage, stepMaxMinutes } from '../domain';
import { aliasPool, assembleSteps } from './assemble';
import { coreConcepts, selectCards } from './select-cards';
import { designPath } from './design-loop';
import { GENERATE_PATH_JOB, type GeneratePathPayload, generatePathPayload } from './jobs';
import { stepView } from './path.view';
import { PATH_DESIGNER, type PathDesigner } from './ports/path-designer';
import { PATH_REPOSITORY, type PathRecord, type PathRepository } from './ports/path.repository';
import { RefundPathCharge } from './refund-path-charge.usecase';

/** Settings for path generation: the resources' language (PATH_RESOURCE_LANGUAGE, default en). */
export const PATH_SETTINGS = Symbol('PathSettings');
export interface PathSettings {
  language: string;
}

/** How long a waiting path sleeps before it rechecks its pools; ResourcesReady usually wakes it first. */
export const POOL_RECHECK_MS = 60_000;

/**
 * `generate-path` (PRD-API §5, plan §1.2). Waits, without using attempts, for the placement-stage and
 * target-stage pools; designs with Sonnet; validates in code and regenerates once with the errors;
 * a second failure goes to review (the job still completes). A dead job, or one whose resources never
 * arrived (the 30-minute wait cap), refunds the charge.
 */
@Injectable()
export class GeneratePath implements JobHandler<GeneratePathPayload> {
  readonly type = GENERATE_PATH_JOB;
  readonly concurrency = 2;
  /** Two Sonnet calls of up to 90 s each (regenerate-once) plus the reads and the save. */
  readonly timeoutMs = 240_000;
  readonly maxWaitMs = 30 * 60_000;
  private readonly logger = new Logger(GeneratePath.name);

  constructor(
    @Inject(PATH_REPOSITORY) private readonly repo: PathRepository,
    @Inject(PATH_DESIGNER) private readonly designer: PathDesigner,
    private readonly served: ServedCardsQuery,
    private readonly discovery: RequestDiscovery,
    private readonly topics: GetTopicProfileQuery,
    private readonly reviews: ReviewQueue,
    private readonly uow: UnitOfWork,
    private readonly refund: RefundPathCharge,
    @Inject(PATH_SETTINGS) private readonly settings: PathSettings,
  ) {}

  parse(payload: unknown): GeneratePathPayload {
    const parsed = generatePathPayload.safeParse(payload);
    if (!parsed.success) throw new NonRetryableJobError(`Invalid generate-path payload: ${parsed.error.message}`);
    return parsed.data;
  }

  async run(payload: GeneratePathPayload, ctx: JobContext): Promise<JobOutcome> {
    const resultRef = `/v1/paths/${payload.pathId}`;
    const path = await this.repo.findById(payload.pathId);
    if (!path) throw new NonRetryableJobError('Path not found');
    // A re-run after the path was settled (a retry racing a success) has nothing left to do.
    if (path.status === 'active' || path.status === 'under_review' || path.status === 'completed') return { resultRef };
    if (path.status === 'failed') throw new NonRetryableJobError('Path already failed');

    const cards = await this.pools(path, payload, ctx);
    if (cards.length === 0) throw new NonRetryableJobError('No usable resources for this topic and stage');

    const topic = await this.topics.execute(path.topicId);
    if (!topic) throw new NonRetryableJobError('Topic not found');
    const weeklyHours = path.weeklyHours ?? 3;
    const selection = selectCards(cards, { language: this.settings.language, formats: payload.formats, stepMax: stepMaxMinutes(weeklyHours) });
    if (selection.cards.length === 0) throw new NonRetryableJobError(`No usable resources in ${this.settings.language} for this topic and stage`);
    const { design, validate, byAlias } = aliasPool(selection.cards);
    const request = {
      topic: { name: topic.canonicalName, domain: topic.domain ?? 'unknown' },
      placement: path.from,
      target: path.to.stage,
      goal: path.goal,
      weeklyHours,
      budgetMinutes: Math.round(weeklyHours * 60 * PATH_LENGTH_WEEKS),
      stepMaxMinutes: stepMaxMinutes(weeklyHours),
      formats: payload.formats,
      cards: design,
      coreConcepts: coreConcepts(selection.cards, { stages: payload.stages, target: path.to.stage }),
      formatFallback: selection.formatFallback,
      // Wired to the catalog's stored maps in the next commit (fix 4, production wiring).
      conceptMap: null,
      jobId: ctx.jobId,
      budgetScope: payload.budgetScope,
      signal: ctx.signal,
    };

    const { designed, errors, flags, attempts } = await designPath(
      this.designer,
      request,
      { pool: validate, placementBloom: path.from.bloom, target: path.to.stage, weeklyHours },
      (phase, attempt) =>
        phase === 'design' ? ctx.progress('design', attempt - 1, 2, attempt === 1 ? 'Designing your path' : 'Fixing the plan') : ctx.progress('validate', attempt, 2),
    );
    if (errors.length > 0 || attempts > 1) this.logger.warn({ pathId: path.id, attempts, errors: errors.length }, 'Designed path needed a regeneration');
    const meta = { model: designed.model, promptVersion: designed.promptVersion };

    if (errors.length > 0) {
      const draft = designed;
      await this.uow.run(async (tx) => {
        if (!(await this.repo.setStatus(tx, path.id, 'generating', 'under_review', meta))) return;
        await this.reviews.flag(tx, { kind: 'path', targetId: path.id, reason: 'validation_failed', detail: { errors, steps: draft.steps } });
      });
      return { resultRef };
    }

    const steps = assembleSteps(designed.steps, byAlias, { formatFallback: selection.formatFallback });
    const activated = await this.uow.run(async (tx, scope) => {
      if (!(await this.repo.activate(tx, path.id, steps, meta))) return false;
      if (flags.includes('few_resource_types')) await this.reviews.flag(tx, { kind: 'path', targetId: path.id, reason: 'few_resource_types' });
      scope.publish(new PathGenerated(path.id, path.userId, path.topicId));
      return true;
    });
    if (activated) {
      const [first] = await this.repo.steps(path.id);
      if (first) await ctx.partial({ kind: 'path_step', pathId: path.id, step: stepView(first, new Map(cards.map((c) => [c.resourceId, c]))) });
    }
    return { resultRef };
  }

  /** Refunds once the job is dead; the wait cap gets its own reason. */
  async onDead(payload: GeneratePathPayload, info: { jobId: string; error: unknown }): Promise<void> {
    const reason = info.error instanceof JobWaitExpiredError ? 'wait_expired' : 'generation_failed';
    await this.refund.execute(payload.pathId, reason, { from: 'generating' });
  }

  /**
   * The cards of the placement-stage pool, then the target-stage pool (deduplicated). Missing or
   * expired pools are requested (charged: past the per-learner cap); while any pool is still being
   * built the job reschedules itself.
   */
  private async pools(path: PathRecord, payload: GeneratePathPayload, ctx: JobContext): Promise<ServedCard[]> {
    const cards: ServedCard[] = [];
    const waiting: { stage: Stage; analysed: number; candidates: number }[] = [];
    for (const stage of payload.stages) {
      const { pool, cards: served } = await this.served.pool(path.topicId, stage);
      if (!pool || pool.expiresAt.getTime() <= Date.now()) {
        const outcome = await this.discovery.execute({ topicId: path.topicId, stage, userId: path.userId, charged: { budgetScope: payload.budgetScope } });
        if (outcome === 'over_budget') throw new ProblemException(503, 'AI_BUDGET_EXCEEDED', 'Daily AI budget reached', { detail: 'Try again after midnight UTC.' });
        waiting.push({ stage, analysed: 0, candidates: 0 });
        continue;
      }
      if (pool.status === 'analysing') {
        waiting.push({ stage, analysed: pool.analysed, candidates: pool.candidates });
        continue;
      }
      for (const card of served) if (!cards.some((c) => c.resourceId === card.resourceId)) cards.push(card);
    }
    if (waiting.length === 0) return cards;

    const analysing = waiting.filter((w) => w.candidates > 0);
    if (analysing.length === 0) await ctx.progress('discover', 0, 1, 'Finding resources');
    else {
      const done = analysing.reduce((n, w) => n + w.analysed, 0);
      const total = analysing.reduce((n, w) => n + w.candidates, 0);
      await ctx.progress('analyse', done, total, `${done} of ${total} resources analysed`);
    }
    throw new RescheduleJob(POOL_RECHECK_MS, `waiting for pools: ${waiting.map((w) => w.stage).join(', ')}`);
  }
}
