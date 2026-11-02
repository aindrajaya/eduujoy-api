import { Inject, Injectable } from '@nestjs/common';
import { eq } from 'drizzle-orm';
import { DATABASE, type Database } from '../../../shared/db';
import { diagnosticSessions, placements } from '../../../shared/db/schema/assessment';
import { type PlacementForPath, type PlacementReader } from '../application/ports/placement.reader';

@Injectable()
export class DrizzlePlacementReader implements PlacementReader {
  constructor(@Inject(DATABASE) private readonly db: Database) {}

  async findForPath(placementId: string): Promise<PlacementForPath | null> {
    const [row] = await this.db
      .select({
        id: placements.id,
        userId: placements.userId,
        topicId: placements.topicId,
        stage: placements.stage,
        bloom: placements.bloom,
        goal: diagnosticSessions.goal,
        weeklyHours: diagnosticSessions.weeklyHours,
        preferredFormats: diagnosticSessions.preferredFormats,
        createdAt: placements.createdAt,
      })
      .from(placements)
      .innerJoin(diagnosticSessions, eq(diagnosticSessions.id, placements.sessionId))
      .where(eq(placements.id, placementId));
    return row ?? null;
  }
}
