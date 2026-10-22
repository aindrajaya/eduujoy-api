import { Inject, Injectable } from '@nestjs/common';
import { asc, eq } from 'drizzle-orm';
import { type AccountDataContributor } from '../../../shared/common/account';
import { DATABASE, type Database } from '../../../shared/db';
import { feedbackEvents, learnerPositions } from '../../../shared/db/schema/progress';

@Injectable()
export class ProgressAccountData implements AccountDataContributor {
  readonly section = 'progress';

  constructor(@Inject(DATABASE) private readonly db: Database) {}

  async export(userId: string): Promise<unknown> {
    const positions = await this.db
      .select({ topicId: learnerPositions.topicId, stage: learnerPositions.stage, bloom: learnerPositions.bloom, confidence: learnerPositions.confidence, source: learnerPositions.source, createdAt: learnerPositions.createdAt })
      .from(learnerPositions)
      .where(eq(learnerPositions.userId, userId))
      .orderBy(asc(learnerPositions.createdAt));
    const feedback = await this.db
      .select({ targetType: feedbackEvents.targetType, targetId: feedbackEvents.targetId, kind: feedbackEvents.kind, comment: feedbackEvents.comment, createdAt: feedbackEvents.createdAt })
      .from(feedbackEvents)
      .where(eq(feedbackEvents.userId, userId))
      .orderBy(asc(feedbackEvents.createdAt));
    return { positions, feedback };
  }
}
