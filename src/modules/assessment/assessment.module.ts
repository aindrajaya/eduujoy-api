import { Module } from '@nestjs/common';
import { CatalogModule } from '../catalog/catalog.module';
import { GetDiagnostic } from './application/get-diagnostic.query';
import { DIAGNOSTIC_REPOSITORY } from './application/ports/diagnostic.repository';
import { StartDiagnostic } from './application/start-diagnostic.usecase';
import { SubmitDiagnosticAnswers } from './application/submit-answers.usecase';
import { DrizzleDiagnosticRepository } from './infrastructure/drizzle-diagnostic.repository';
import { DiagnosticsController } from './interface/diagnostics.controller';

/** Assessment (PRD-API §4). A7: diagnostics and placement; A10 adds checkpoints and grading. */
@Module({
  imports: [CatalogModule],
  controllers: [DiagnosticsController],
  providers: [StartDiagnostic, SubmitDiagnosticAnswers, GetDiagnostic, { provide: DIAGNOSTIC_REPOSITORY, useClass: DrizzleDiagnosticRepository }],
})
export class AssessmentModule {}
