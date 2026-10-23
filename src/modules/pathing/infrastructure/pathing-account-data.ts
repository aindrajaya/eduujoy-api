import { Inject, Injectable } from '@nestjs/common';
import { asc, eq } from 'drizzle-orm';
import { type AccountDataContributor } from '../../../shared/common/account';
import { DATABASE, type Database } from '../../../shared/db';
import { paths, pathSteps } from '../../../shared/db/schema/pathing';

/** Paths and their steps. Checkpoint answer keys are never included; deletion cascades from the user row. */
@Injectable()
export class PathingAccountData implements AccountDataContributor {
  readonly section = 'pathing';

  constructor(@Inject(DATABASE) private readonly db: Database) {}

  async export(userId: string): Promise<unknown> {
    const own = await this.db
      .select({
        id: paths.id,
        topicId: paths.topicId,
        placementId: paths.placementId,
        fromStage: paths.fromStage,
        fromBloom: paths.fromBloom,
        toStage: paths.toStage,
        toBloom: paths.toBloom,
        status: paths.status,
        goal: paths.goal,
        weeklyHours: paths.weeklyHours,
        refundedAt: paths.refundedAt,
        createdAt: paths.createdAt,
        updatedAt: paths.updatedAt,
      })
      .from(paths)
      .where(eq(paths.userId, userId))
      .orderBy(asc(paths.createdAt));
    const steps = await this.db
      .select({
        pathId: pathSteps.pathId,
        id: pathSteps.id,
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
        updatedAt: pathSteps.updatedAt,
      })
      .from(pathSteps)
      .innerJoin(paths, eq(paths.id, pathSteps.pathId))
      .where(eq(paths.userId, userId))
      .orderBy(asc(pathSteps.pathId), asc(pathSteps.n));
    return { paths: own, steps };
  }
}
