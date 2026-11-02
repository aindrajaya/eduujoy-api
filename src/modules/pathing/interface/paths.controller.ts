import { Body, Controller, Get, HttpCode, Param, Patch, Post, Query, SerializeOptions } from '@nestjs/common';
import { ApiHeader, ApiOkResponse, ApiOperation, ApiParam, ApiQuery, ApiResponse, ApiTags } from '@nestjs/swagger';
import { type AuthUser, CurrentUser } from '../../../shared/common/auth';
import { IdempotencyKey } from '../../../shared/common/http';
import { ApiAccessCookieAuth, ApiBudgetExceeded, ApiCsrfHeader, ApiIdempotencyKeyHeader, ApiProblem } from '../../../shared/common/openapi';
import { type PathSummaryView, type PathView, type StepView } from '../application/path.view';
import { PathsQueries } from '../application/paths.queries';
import { type JobAcceptedView, RequestPath } from '../application/request-path.usecase';
import { PathCreateRequestDto, PathListQueryDto, StepPatchRequestDto } from './dto/path.request';
import { JobAcceptedDto, PathDto, PathListResponseDto, PathStepDto } from './dto/path.response';

const ID_PARAM = { name: 'id', schema: { type: 'string', maxLength: 64 } } as const;
const IF_NONE_MATCH = { name: 'If-None-Match', required: false, schema: { type: 'string' } } as const;
const ETAG = { ETag: { schema: { type: 'string' } } };

@ApiTags('pathing')
@ApiAccessCookieAuth()
@Controller('v1/paths')
export class PathsController {
  constructor(
    private readonly request: RequestPath,
    private readonly queries: PathsQueries,
  ) {}

  @Post()
  @HttpCode(202)
  @SerializeOptions({ type: JobAcceptedDto })
  @ApiOperation({ operationId: 'pathsCreate', summary: 'Request a path; asynchronous (FR-13).' })
  @ApiCsrfHeader()
  @ApiIdempotencyKeyHeader(true)
  @ApiResponse({ status: 202, description: 'Job accepted. Stream progress from `GET /v1/jobs/{jobId}/events`.', type: JobAcceptedDto })
  @ApiProblem(400)
  @ApiProblem(401)
  @ApiProblem(402, 'Plan quota or credits exhausted (code QUOTA_EXCEEDED).')
  @ApiProblem(403)
  @ApiProblem(404, "Unknown placement, or a placement that is not the caller's (code NOT_FOUND).")
  @ApiProblem(409)
  @ApiProblem(429)
  @ApiBudgetExceeded()
  create(
    @CurrentUser() user: AuthUser,
    @IdempotencyKey({ required: true }) key: string,
    @Body() body: PathCreateRequestDto,
  ): Promise<JobAcceptedView> {
    return this.request.execute({
      userId: user.userId,
      idempotencyKey: key,
      placementId: body.placementId,
      ...(body.goal === undefined ? {} : { goal: body.goal }),
      ...(body.weeklyHours === undefined ? {} : { weeklyHours: body.weeklyHours }),
    });
  }

  @Get()
  @SerializeOptions({ type: PathListResponseDto })
  @ApiOperation({ operationId: 'pathsList', summary: 'List my paths.' })
  @ApiHeader(IF_NONE_MATCH)
  @ApiQuery({ name: 'topicId', required: false, schema: { type: 'string' } })
  @ApiQuery({
    name: 'status',
    required: false,
    description: 'Only paths with this status, for example `active` for the Today screen.',
    schema: { type: 'string', enum: ['generating', 'active', 'completed', 'failed', 'under_review'] },
  })
  @ApiQuery({ name: 'cursor', required: false, schema: { type: 'string', maxLength: 256 } })
  @ApiQuery({ name: 'limit', required: false, schema: { type: 'integer', minimum: 1, maximum: 50, default: 20 } })
  @ApiOkResponse({ description: 'Paths, newest first.', type: PathListResponseDto, headers: ETAG })
  @ApiResponse({ status: 304, description: 'Not modified.' })
  @ApiProblem(401)
  list(@CurrentUser() user: AuthUser, @Query() query: PathListQueryDto): Promise<{ items: PathSummaryView[]; nextCursor: string | null }> {
    return this.queries.list(user.userId, {
      limit: query.limit ?? 20,
      ...(query.status ? { status: query.status } : {}),
      ...(query.topicId ? { topicId: query.topicId } : {}),
      ...(query.cursor ? { cursor: query.cursor } : {}),
    });
  }

  @Get(':id')
  @SerializeOptions({ type: PathDto })
  @ApiOperation({
    operationId: 'pathsGet',
    summary: 'Read one path with its steps and resources.',
    description:
      '404 also while the path is still being generated: a generating path is not a Path yet.\nFollow the `jobId` from POST /v1/paths over GET /v1/jobs/{id}/events until it completes.\n',
  })
  @ApiParam(ID_PARAM)
  @ApiHeader(IF_NONE_MATCH)
  @ApiOkResponse({ description: 'Path.', type: PathDto, headers: ETAG })
  @ApiResponse({ status: 304, description: 'Not modified.' })
  @ApiProblem(401)
  @ApiProblem(403)
  @ApiProblem(404)
  get(@CurrentUser() user: AuthUser, @Param('id') id: string): Promise<PathView> {
    return this.queries.get(user.userId, id);
  }
}

@ApiTags('pathing')
@ApiAccessCookieAuth()
@Controller('v1/steps')
export class StepsController {
  constructor(private readonly queries: PathsQueries) {}

  @Patch(':id')
  @SerializeOptions({ type: PathStepDto })
  @ApiOperation({ operationId: 'stepsUpdate', summary: 'Mark actions done, rate difficulty (US-08), change step status.' })
  @ApiCsrfHeader()
  @ApiParam(ID_PARAM)
  @ApiOkResponse({ description: 'Updated step.', type: PathStepDto })
  @ApiProblem(400)
  @ApiProblem(401)
  @ApiProblem(403)
  @ApiProblem(404)
  update(@CurrentUser() user: AuthUser, @Param('id') id: string, @Body() body: StepPatchRequestDto): Promise<StepView> {
    return this.queries.patchStep(user.userId, id, {
      ...(body.actionsDone ? { actionsDone: body.actionsDone.map((a) => ({ n: a.n, done: a.done })) } : {}),
      ...(body.difficulty ? { difficulty: body.difficulty } : {}),
      ...(body.status ? { status: body.status } : {}),
    });
  }
}
