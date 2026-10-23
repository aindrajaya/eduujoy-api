import { Inject, Injectable } from '@nestjs/common';
import { and, asc, desc, eq, gte, inArray, isNull, lt, or, sql } from 'drizzle-orm';
import { DATABASE, type Database, type Tx } from '../../../shared/db';
import { pathRequestReplays, paths, pathSteps } from '../../../shared/db/schema/pathing';
import {
  type ListFilter,
  type NewStep,
  type PathRecord,
  type PathReplay,
  type PathRepository,
  type PathStatus,
  type PathSummaryRecord,
  type StepPatch,
  type StepPatchOutcome,
  type StepRecord,
  type StoredCheckpoint,
} from '../application/ports/path.repository';

/** Postgres unique_violation. */
const UNIQUE_VIOLATION = '23505';

function pgCode(error: unknown): string | undefined {
  const own = (error as { code?: unknown }).code;
  const cause = (error as { cause?: { code?: unknown } }).cause?.code;
  return typeof own === 'string' ? own : typeof cause === 'string' ? cause : undefined;
}

type PathRow = typeof paths.$inferSelect;
type StepRow = typeof pathSteps.$inferSelect;

const toPath = (r: PathRow): PathRecord => ({
  id: r.id,
  userId: r.userId,
  topicId: r.topicId,
  placementId: r.placementId,
  from: { stage: r.fromStage, bloom: r.fromBloom },
  to: { stage: r.toStage, bloom: r.toBloom },
  status: r.status,
  goal: r.goal,
  weeklyHours: r.weeklyHours,
  jobId: r.jobId,
  refundedAt: r.refundedAt,
  createdAt: r.createdAt,
  updatedAt: r.updatedAt,
});

/** Never selects answer_keys: they stay server-side. */
const STEP = {
  id: pathSteps.id,
  pathId: pathSteps.pathId,
  n: pathSteps.n,
  objective: pathSteps.objective,
  bloom: pathSteps.bloom,
  actions: pathSteps.actions,
  resourceIds: pathSteps.resourceIds,
  checkpoint: pathSteps.checkpoint,
  doneWhen: pathSteps.doneWhen,
  estMinutes: pathSteps.estMinutes,
  status: pathSteps.status,
  remedial: pathSteps.remedial,
  difficulty: pathSteps.difficulty,
};

const toStep = (r: Omit<StepRow, 'answerKeys' | 'createdAt' | 'updatedAt'>): StepRecord => ({
  ...r,
  actions: r.actions as StepRecord['actions'],
  checkpoint: r.checkpoint as StoredCheckpoint,
});

/** created_at at the cursor's precision: a JS Date carries milliseconds, Postgres microseconds. */
const CREATED_MS = sql<Date>`date_trunc('milliseconds', ${paths.createdAt})`;

@Injectable()
export class DrizzlePathRepository implements PathRepository {
  constructor(@Inject(DATABASE) private readonly db: Database) {}

  async create(
    tx: Tx,
    input: { userId: string; topicId: string; placementId: string; from: PathRecord['from']; to: PathRecord['to']; goal: string | null; weeklyHours: number },
  ): Promise<string | null> {
    try {
      // A savepoint, so a lost race on the live-placement index doesn't abort the caller's transaction.
      return await tx.transaction(async (inner) => {
        const [row] = await inner
          .insert(paths)
          .values({
            userId: input.userId,
            topicId: input.topicId,
            placementId: input.placementId,
            fromStage: input.from.stage,
            fromBloom: input.from.bloom,
            toStage: input.to.stage,
            toBloom: input.to.bloom,
            goal: input.goal,
            weeklyHours: input.weeklyHours,
          })
          .returning({ id: paths.id });
        return row?.id ?? null;
      });
    } catch (error) {
      if (pgCode(error) === UNIQUE_VIOLATION) return null;
      throw error;
    }
  }

  async findLiveForPlacement(userId: string, placementId: string): Promise<PathRecord | null> {
    const [row] = await this.db
      .select()
      .from(paths)
      .where(and(eq(paths.userId, userId), eq(paths.placementId, placementId), sql`${paths.status} <> 'failed'`));
    return row ? toPath(row) : null;
  }

  async setJob(tx: Tx, pathId: string, jobId: string): Promise<void> {
    await tx.update(paths).set({ jobId }).where(eq(paths.id, pathId));
  }

  async findReplay(userId: string, idempotencyKey: string): Promise<PathReplay | null> {
    const [row] = await this.db
      .select()
      .from(pathRequestReplays)
      .where(and(eq(pathRequestReplays.userId, userId), eq(pathRequestReplays.idempotencyKey, idempotencyKey)));
    return row ? { pathId: row.pathId, requestHash: row.requestHash, response: row.response as PathReplay['response'] } : null;
  }

  async saveReplay(tx: Tx, input: PathReplay & { userId: string; idempotencyKey: string }): Promise<boolean> {
    const rows = await tx
      .insert(pathRequestReplays)
      .values({ userId: input.userId, pathId: input.pathId, idempotencyKey: input.idempotencyKey, requestHash: input.requestHash, response: input.response })
      .onConflictDoNothing()
      .returning({ id: pathRequestReplays.id });
    return rows.length > 0;
  }

  async countCreatedSince(userId: string, since: Date): Promise<number> {
    const [row] = await this.db
      .select({ n: sql<number>`count(*)::int` })
      .from(paths)
      .where(and(eq(paths.userId, userId), gte(paths.createdAt, since)));
    return row?.n ?? 0;
  }

  async findById(pathId: string): Promise<PathRecord | null> {
    const [row] = await this.db.select().from(paths).where(eq(paths.id, pathId));
    return row ? toPath(row) : null;
  }

  async activate(tx: Tx, pathId: string, steps: NewStep[], meta: { model: string; promptVersion: string }): Promise<boolean> {
    const moved = await tx
      .update(paths)
      .set({ status: 'active', model: meta.model, promptVersion: meta.promptVersion })
      .where(and(eq(paths.id, pathId), eq(paths.status, 'generating')))
      .returning({ id: paths.id });
    if (moved.length === 0) return false;
    await tx.insert(pathSteps).values(
      steps.map((s, i) => ({
        pathId,
        n: s.n,
        objective: s.objective,
        bloom: s.bloom,
        actions: s.actions,
        resourceIds: s.resourceIds,
        checkpoint: s.checkpoint,
        answerKeys: s.answerKeys,
        doneWhen: s.doneWhen,
        estMinutes: s.estMinutes,
        status: i === 0 ? ('active' as const) : ('locked' as const),
      })),
    );
    return true;
  }

  async setStatus(tx: Tx, pathId: string, from: PathStatus, to: PathStatus, meta?: { model: string; promptVersion: string }): Promise<boolean> {
    const rows = await tx
      .update(paths)
      .set({ status: to, ...(meta ? { model: meta.model, promptVersion: meta.promptVersion } : {}) })
      .where(and(eq(paths.id, pathId), eq(paths.status, from)))
      .returning({ id: paths.id });
    return rows.length > 0;
  }

  async markRefunded(tx: Tx, pathId: string): Promise<boolean> {
    const rows = await tx
      .update(paths)
      .set({ refundedAt: sql`now()` })
      .where(and(eq(paths.id, pathId), isNull(paths.refundedAt)))
      .returning({ id: paths.id });
    return rows.length > 0;
  }

  async list(userId: string, filter: ListFilter): Promise<PathSummaryRecord[]> {
    const rows = await this.db
      .select()
      .from(paths)
      .where(
        and(
          eq(paths.userId, userId),
          filter.status ? eq(paths.status, filter.status) : undefined,
          filter.topicId ? eq(paths.topicId, filter.topicId) : undefined,
          filter.before ? or(lt(CREATED_MS, filter.before.createdAt), and(eq(CREATED_MS, filter.before.createdAt), lt(paths.id, filter.before.id))) : undefined,
        ),
      )
      .orderBy(desc(CREATED_MS), desc(paths.id))
      .limit(filter.limit);
    return this.summarise(rows.map(toPath));
  }

  async summary(userId: string, pathId: string): Promise<PathSummaryRecord | null> {
    const [row] = await this.db.select().from(paths).where(and(eq(paths.id, pathId), eq(paths.userId, userId)));
    if (!row) return null;
    const [summary] = await this.summarise([toPath(row)]);
    return summary ?? null;
  }

  async steps(pathId: string): Promise<StepRecord[]> {
    const rows = await this.db.select(STEP).from(pathSteps).where(eq(pathSteps.pathId, pathId)).orderBy(asc(pathSteps.n));
    return rows.map(toStep);
  }

  /** Step counts, total minutes and the current step for each path, in one query. */
  private async summarise(list: PathRecord[]): Promise<PathSummaryRecord[]> {
    if (list.length === 0) return [];
    const ids = list.map((p) => p.id);
    const steps = await this.db
      .select({ pathId: pathSteps.pathId, id: pathSteps.id, n: pathSteps.n, objective: pathSteps.objective, bloom: pathSteps.bloom, estMinutes: pathSteps.estMinutes, status: pathSteps.status })
      .from(pathSteps)
      .where(inArray(pathSteps.pathId, ids))
      .orderBy(asc(pathSteps.pathId), asc(pathSteps.n));
    return list.map((p) => {
      const own = steps.filter((s) => s.pathId === p.id);
      const done = own.filter((s) => s.status === 'completed' || s.status === 'skipped').length;
      const current = p.status === 'active' ? own.find((s) => s.status !== 'completed' && s.status !== 'skipped') : undefined;
      return {
        ...p,
        stepsDone: done,
        stepsTotal: own.length,
        totalMinutes: own.reduce((n, s) => n + s.estMinutes, 0),
        currentStep: current ? { id: current.id, n: current.n, objective: current.objective, bloom: current.bloom, estMinutes: current.estMinutes, status: current.status } : null,
      };
    });
  }

  patchStep(userId: string, stepId: string, patch: StepPatch): Promise<StepPatchOutcome> {
    return this.db.transaction(async (tx) => {
      const [owned] = await tx
        .select({ step: STEP, pathStatus: paths.status })
        .from(pathSteps)
        .innerJoin(paths, eq(paths.id, pathSteps.pathId))
        .where(and(eq(pathSteps.id, stepId), eq(paths.userId, userId)))
        .for('update', { of: paths });
      if (!owned) return { kind: 'not_found' };
      const step = toStep(owned.step);
      if (patch.status && (step.status !== 'active' || owned.pathStatus !== 'active')) return { kind: 'not_active' };

      const doneByN = new Map((patch.actionsDone ?? []).map((a) => [a.n, a.done]));
      const actions = step.actions.map((a) => (doneByN.has(a.n) ? { ...a, done: doneByN.get(a.n) as boolean } : a));
      const [updated] = await tx
        .update(pathSteps)
        .set({ actions, ...(patch.difficulty ? { difficulty: patch.difficulty } : {}), ...(patch.status ? { status: patch.status } : {}) })
        .where(eq(pathSteps.id, stepId))
        .returning(STEP);
      if (!updated) return { kind: 'not_found' };

      let unlocked: StepRecord | null = null;
      let pathCompleted = false;
      if (patch.status) {
        const [next] = await tx
          .update(pathSteps)
          .set({ status: 'active' })
          .where(
            and(
              eq(pathSteps.pathId, step.pathId),
              eq(pathSteps.status, 'locked'),
              sql`${pathSteps.n} = (select min(n) from path_steps where path_id = ${step.pathId} and status = 'locked')`,
            ),
          )
          .returning(STEP);
        unlocked = next ? toStep(next) : null;
        if (!next) {
          const [open] = await tx
            .select({ n: sql<number>`count(*)::int` })
            .from(pathSteps)
            .where(and(eq(pathSteps.pathId, step.pathId), sql`${pathSteps.status} in ('locked', 'active')`));
          if ((open?.n ?? 0) === 0) pathCompleted = await this.setStatus(tx, step.pathId, 'active', 'completed');
        }
      }
      return { kind: 'ok', step: toStep(updated), pathCompleted, unlocked };
    });
  }

  async reviewOverdue(cutoff: Date, limit: number): Promise<PathRecord[]> {
    const rows = await this.db
      .select()
      .from(paths)
      .where(and(eq(paths.status, 'under_review'), isNull(paths.refundedAt), lt(paths.updatedAt, cutoff)))
      .orderBy(asc(paths.updatedAt))
      .limit(limit);
    return rows.map(toPath);
  }
}
