import { Module } from '@nestjs/common';
import { POSITION_REPOSITORY } from './application/ports/position.repository';
import { RecordPosition } from './application/record-position.usecase';
import { DrizzlePositionRepository } from './infrastructure/drizzle-position.repository';
import { PlacementComputedListener } from './infrastructure/placement-computed.listener';

/** Progress (PRD-API §4). A7 records diagnostic positions; A11 adds progress reads and history. */
@Module({
  providers: [RecordPosition, PlacementComputedListener, { provide: POSITION_REPOSITORY, useClass: DrizzlePositionRepository }],
})
export class ProgressModule {}
