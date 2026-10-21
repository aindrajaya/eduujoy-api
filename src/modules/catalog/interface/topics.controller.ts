import { Body, Controller, HttpCode, Post, SerializeOptions, UseInterceptors } from '@nestjs/common';
import { ApiOkResponse, ApiOperation, ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import { type AuthUser, CurrentUser } from '../../../shared/common/auth';
import { ApiAccessCookieAuth, ApiCsrfHeader, ApiProblem, ApiServiceUnavailable } from '../../../shared/common/openapi';
import { ResolveTopic, type ResolveTopicView } from '../application/resolve-topic.usecase';
import { CatalogErrorsInterceptor } from './catalog-errors.interceptor';
import { TopicResolveRequestDto } from './dto/topic-resolve.request';
import { TopicResolveResponseDto } from './dto/topic-resolve.response';

/** Each resolve may cost an embedding call; creating is capped separately per day. */
const RESOLVE_THROTTLE = { default: { limit: 30, ttl: 60_000 } };

@ApiTags('catalog')
@ApiAccessCookieAuth()
@Controller('v1/topics')
@UseInterceptors(CatalogErrorsInterceptor)
export class TopicsController {
  constructor(private readonly resolveTopic: ResolveTopic) {}

  @Post('resolve')
  @HttpCode(200)
  @Throttle(RESOLVE_THROTTLE)
  @SerializeOptions({ type: TopicResolveResponseDto })
  @ApiOperation({
    operationId: 'topicsResolve',
    summary: 'Resolve free text to a canonical topic or up to 3 choices (FR-01, FR-02).',
    description:
      'If the embedding provider is unavailable, the API falls back to a name and alias search\nand returns `choices` when any are close enough; it never creates a topic during an\noutage. If nothing is close, it returns 503 with Retry-After.\n',
  })
  @ApiCsrfHeader()
  @ApiOkResponse({ description: 'Resolution result.', type: TopicResolveResponseDto })
  @ApiProblem(400)
  @ApiProblem(401)
  @ApiProblem(429)
  @ApiServiceUnavailable()
  resolve(@CurrentUser() user: AuthUser, @Body() body: TopicResolveRequestDto): Promise<ResolveTopicView> {
    return this.resolveTopic.execute(user.userId, body.text);
  }
}
