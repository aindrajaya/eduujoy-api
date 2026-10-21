import { Controller, Get, HttpStatus, Req, Res } from '@nestjs/common';
import { type Request, type Response } from 'express';
import { AppConfig } from '../../config';
import { Public } from '../auth/decorators';
import { ReadinessRegistry } from './readiness.registry';

interface HealthBody {
  status: 'ok';
  version: string;
  checks?: Record<string, string>;
}

@Public()
@Controller()
export class HealthController {
  constructor(
    private readonly config: AppConfig,
    private readonly readiness: ReadinessRegistry,
  ) {}

  @Get('health')
  health(): HealthBody {
    return { status: 'ok', version: this.version };
  }

  @Get('ready')
  async ready(@Req() req: Request, @Res({ passthrough: true }) res: Response): Promise<HealthBody | undefined> {
    const { ready, checks } = await this.readiness.run();
    if (ready) return { status: 'ok', version: this.version, checks };

    res
      .status(HttpStatus.SERVICE_UNAVAILABLE)
      .type('application/problem+json')
      .json({
        type: `${this.config.env.API_PUBLIC_URL}/problems/not-ready`,
        title: 'Service not ready',
        status: HttpStatus.SERVICE_UNAVAILABLE,
        detail: `Failing checks: ${Object.keys(checks)
          .filter((name) => checks[name] !== 'ok')
          .join(', ')}`,
        code: 'INTERNAL',
        requestId: typeof req.id === 'string' ? req.id : '',
      });
    return undefined;
  }

  private get version(): string {
    return this.config.env.APP_VERSION ?? 'dev';
  }
}
