import { Controller, Get, HttpStatus, SerializeOptions } from '@nestjs/common';
import { AppConfig } from '../../config';
import { Public } from '../auth/decorators';
import { ProblemException } from '../problem/problem';
import { HealthResponseDto } from './health.response';
import { ReadinessRegistry } from './readiness.registry';

@Public()
@SerializeOptions({ type: HealthResponseDto })
@Controller()
export class HealthController {
  constructor(
    private readonly config: AppConfig,
    private readonly readiness: ReadinessRegistry,
  ) {}

  @Get('health')
  health(): HealthResponseDto {
    return { status: 'ok', version: this.version };
  }

  @Get('ready')
  async ready(): Promise<HealthResponseDto> {
    const { ready, checks } = await this.readiness.run();
    if (ready) return { status: 'ok', version: this.version, checks };

    const failing = Object.keys(checks).filter((name) => checks[name] !== 'ok');
    throw new ProblemException(HttpStatus.SERVICE_UNAVAILABLE, 'SERVICE_UNAVAILABLE', 'Service not ready', {
      detail: `Failing checks: ${failing.join(', ')}`,
      typeSlug: 'not-ready',
    });
  }

  private get version(): string {
    return this.config.env.APP_VERSION ?? 'dev';
  }
}
