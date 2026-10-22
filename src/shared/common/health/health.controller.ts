import { Controller, Get, HttpStatus, SerializeOptions } from '@nestjs/common';
import { ApiOkResponse, ApiOperation, ApiTags } from '@nestjs/swagger';
import { AppConfig } from '../../config';
import { Public } from '../auth/decorators';
import { ApiProblem } from '../openapi/decorators';
import { ProblemException } from '../problem/problem';
import { HealthResponseDto } from './health.response';
import { ReadinessRegistry } from './readiness.registry';

@ApiTags('health')
@Public()
@SerializeOptions({ type: HealthResponseDto })
@Controller()
export class HealthController {
  constructor(
    private readonly config: AppConfig,
    private readonly readiness: ReadinessRegistry,
  ) {}

  @Get('health')
  @ApiOperation({ operationId: 'health', summary: 'Liveness.' })
  @ApiOkResponse({ description: 'Alive.', type: HealthResponseDto })
  health(): HealthResponseDto {
    return { status: 'ok', version: this.version };
  }

  @Get('ready')
  @ApiOperation({ operationId: 'ready', summary: 'Readiness; checks the database.' })
  @ApiOkResponse({ description: 'Ready.', type: HealthResponseDto })
  @ApiProblem(503, 'Not ready (a dependency check failed). Code `SERVICE_UNAVAILABLE`, type `/problems/not-ready`.')
  async ready(): Promise<HealthResponseDto> {
    const { ready, checks } = await this.readiness.run();
    if (ready) return { status: 'ok', version: this.version, checks };

    const failing = Object.keys(checks).filter((name) => checks[name] !== 'ok');
    throw new ProblemException(HttpStatus.SERVICE_UNAVAILABLE, 'SERVICE_UNAVAILABLE', 'Service not ready', {
      detail: `Failing checks: ${failing.join(', ')}`,
      typeSlug: 'not-ready',
    });
  }

  /** The deployed commit: the image's APP_VERSION, else Koyeb's runtime KOYEB_GIT_SHA, else `dev`. */
  private get version(): string {
    return this.config.env.APP_VERSION ?? this.config.env.KOYEB_GIT_SHA ?? 'dev';
  }
}
