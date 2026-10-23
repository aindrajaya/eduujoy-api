import { Module } from '@nestjs/common';
import { CatalogModule } from '../catalog/catalog.module';
import { GetDiagnostic } from './application/get-diagnostic.query';
import { GetPlacementForPathQuery } from './application/get-placement-for-path.query';
import { DIAGNOSTIC_REPOSITORY } from './application/ports/diagnostic.repository';
import { PLACEMENT_READER } from './application/ports/placement.reader';
import { StartDiagnostic } from './application/start-diagnostic.usecase';
import { SubmitDiagnosticAnswers } from './application/submit-answers.usecase';
import { DrizzleDiagnosticRepository } from './infrastructure/drizzle-diagnostic.repository';
import { DrizzlePlacementReader } from './infrastructure/drizzle-placement.reader';
import { DiagnosticsController } from './interface/diagnostics.controller';
import { ACCOUNT_DATA } from '../../shared/common/account';
import { AssessmentAccountData } from './infrastructure/assessment-account-data';

/** Assessment (PRD-API §4). A7: diagnostics and placement; A9 reads placements; A10 adds checkpoints and grading. */
@Module({
  imports: [CatalogModule],
  controllers: [DiagnosticsController],
  providers: [
    StartDiagnostic,
    SubmitDiagnosticAnswers,
    GetDiagnostic,
    GetPlacementForPathQuery,
    { provide: DIAGNOSTIC_REPOSITORY, useClass: DrizzleDiagnosticRepository },
    { provide: PLACEMENT_READER, useClass: DrizzlePlacementReader },
    { provide: ACCOUNT_DATA.assessment, useClass: AssessmentAccountData },
  ],
  exports: [GetPlacementForPathQuery, ACCOUNT_DATA.assessment],
})
export class AssessmentModule {}
