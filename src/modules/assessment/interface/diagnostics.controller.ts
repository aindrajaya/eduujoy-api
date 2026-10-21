import { Body, Controller, Get, HttpCode, Param, Post, SerializeOptions, UseInterceptors } from '@nestjs/common';
import { ApiCreatedResponse, ApiOkResponse, ApiOperation, ApiParam, ApiTags } from '@nestjs/swagger';
import { type AuthUser, CurrentUser } from '../../../shared/common/auth';
import { IdempotencyKey } from '../../../shared/common/http';
import { ApiAccessCookieAuth, ApiCsrfHeader, ApiIdempotencyKeyHeader, ApiProblem } from '../../../shared/common/openapi';
import { type DiagnosticBatchView } from '../application/diagnostic.view';
import { type DiagnosticDetailView, GetDiagnostic } from '../application/get-diagnostic.query';
import { StartDiagnostic } from '../application/start-diagnostic.usecase';
import { SubmitDiagnosticAnswers } from '../application/submit-answers.usecase';
import { AssessmentErrorsInterceptor } from './assessment-errors.interceptor';
import { DiagnosticAnswersRequestDto, DiagnosticStartRequestDto } from './dto/diagnostic.request';
import { DiagnosticBatchResponseDto, DiagnosticResponseDto } from './dto/diagnostic.response';

const ID_PARAM = { name: 'id', schema: { type: 'string', maxLength: 64 } } as const;

@ApiTags('assessment')
@ApiAccessCookieAuth()
@Controller('v1/diagnostics')
@UseInterceptors(AssessmentErrorsInterceptor)
export class DiagnosticsController {
  constructor(
    private readonly start: StartDiagnostic,
    private readonly answers: SubmitDiagnosticAnswers,
    private readonly read: GetDiagnostic,
  ) {}

  @Post()
  @HttpCode(201)
  @SerializeOptions({ type: DiagnosticBatchResponseDto })
  @ApiOperation({ operationId: 'diagnosticsStart', summary: 'Start a diagnostic for a topic; returns the first batch of 4 items (FR-03).' })
  @ApiCsrfHeader()
  @ApiCreatedResponse({ description: 'Diagnostic started (or the open one resumed).', type: DiagnosticBatchResponseDto })
  @ApiProblem(400)
  @ApiProblem(401)
  @ApiProblem(404, 'Topic not found (code NOT_FOUND).')
  begin(@CurrentUser() user: AuthUser, @Body() body: DiagnosticStartRequestDto): Promise<DiagnosticBatchView> {
    return this.start.execute({
      userId: user.userId,
      topicId: body.topicId,
      goal: body.goal,
      weeklyHours: body.weeklyHours,
      ...(body.preferredFormats ? { preferredFormats: body.preferredFormats } : {}),
      ...(body.selfReport ? { selfReport: { years: body.selfReport.years, projectsShipped: body.selfReport.projectsShipped } } : {}),
    });
  }

  @Get(':id')
  @SerializeOptions({ type: DiagnosticResponseDto })
  @ApiOperation({ operationId: 'diagnosticsGet', summary: 'Read a diagnostic (resume after a reload); owner only.' })
  @ApiParam(ID_PARAM)
  @ApiOkResponse({ description: 'The diagnostic.', type: DiagnosticResponseDto })
  @ApiProblem(401)
  @ApiProblem(404)
  get(@CurrentUser() user: AuthUser, @Param('id') id: string): Promise<DiagnosticDetailView> {
    return this.read.execute(user.userId, id);
  }

  @Post(':id/answers')
  @HttpCode(200)
  @SerializeOptions({ type: DiagnosticBatchResponseDto })
  @ApiOperation({
    operationId: 'diagnosticsSubmitAnswers',
    summary: 'Submit a batch of answers; returns the next batch or the placement (FR-04).',
    description:
      'Send the same optional `Idempotency-Key` on every retry of one batch. A replay with the same key and body returns the stored 200 ' +
      'response and records nothing twice; the same key with a different body returns 409 CONFLICT.',
  })
  @ApiCsrfHeader()
  @ApiIdempotencyKeyHeader()
  @ApiParam(ID_PARAM)
  @ApiOkResponse({ description: 'Next batch, or the placement when complete.', type: DiagnosticBatchResponseDto })
  @ApiProblem(400)
  @ApiProblem(401)
  @ApiProblem(403)
  @ApiProblem(404)
  @ApiProblem(409, 'The diagnostic is complete, the answers do not match the current batch, or the Idempotency-Key was used with a different request.')
  submit(
    @CurrentUser() user: AuthUser,
    @Param('id') id: string,
    @Body() body: DiagnosticAnswersRequestDto,
    @IdempotencyKey() idempotencyKey: string | undefined,
  ): Promise<DiagnosticBatchView> {
    return this.answers.execute({ userId: user.userId, diagnosticId: id, answers: body.answers, ...(idempotencyKey === undefined ? {} : { idempotencyKey }) });
  }
}
