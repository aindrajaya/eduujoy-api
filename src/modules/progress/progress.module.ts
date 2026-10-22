import { Module } from '@nestjs/common';
import { POSITION_REPOSITORY } from './application/ports/position.repository';
import { RecordPosition } from './application/record-position.usecase';
import { DrizzlePositionRepository } from './infrastructure/drizzle-position.repository';
import { PlacementComputedListener } from './infrastructure/placement-computed.listener';
import { ProgressAccountData } from './infrastructure/progress-account-data';
import { ACCOUNT_DATA } from '../../shared/common/account';

/** Progress (PRD-API §4). A7 records diagnostic positions; A11 adds progress reads and history. */
@Module({
  providers: [
    RecordPosition,
    PlacementComputedListener,
    { provide: POSITION_REPOSITORY, useClass: DrizzlePositionRepository },
    { provide: ACCOUNT_DATA.progress, useClass: ProgressAccountData },
  ],
  exports: [ACCOUNT_DATA.progress],
})
export class ProgressModule {}
