import { Inject, Injectable } from '@nestjs/common';
import { DATABASE, type Database } from '../../../shared/db';
import { learnerPositions } from '../../../shared/db/schema/progress';
import { type NewPosition, type PositionRepository } from '../application/ports/position.repository';

@Injectable()
export class DrizzlePositionRepository implements PositionRepository {
  constructor(@Inject(DATABASE) private readonly db: Database) {}

  async append(position: NewPosition): Promise<void> {
    await this.db.insert(learnerPositions).values(position);
  }
}
