import { Inject, Injectable } from '@nestjs/common';
import { type NewPosition, POSITION_REPOSITORY, type PositionRepository } from './ports/position.repository';

@Injectable()
export class RecordPosition {
  constructor(@Inject(POSITION_REPOSITORY) private readonly positions: PositionRepository) {}

  execute(position: NewPosition): Promise<void> {
    return this.positions.append(position);
  }
}
