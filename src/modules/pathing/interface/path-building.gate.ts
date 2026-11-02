import { Inject, Injectable, type NestMiddleware, NotFoundException } from '@nestjs/common';
import { type NextFunction, type Request, type Response } from 'express';
import { AppConfig } from '../../../shared/config';

/**
 * PATH_BUILDING_ENABLED (user, 3 Nov 2026): A9 ships with path building off in prod until Gate B
 * passes. Off, the pathing routes answer exactly as before A9, when they did not exist: the router's
 * own 404 ("Cannot <METHOD> <url>"), rendered by the same problem filter. It is middleware, not a
 * guard, so it runs before the global auth, CSRF and rate-limit guards, as an unmatched route does:
 * no credit is reserved, no job is enqueued and no LLM is called.
 */
@Injectable()
export class PathBuildingGate implements NestMiddleware {
  constructor(@Inject(AppConfig) private readonly config: AppConfig) {}

  use(req: Request, _res: Response, next: NextFunction): void {
    if (this.config.env.PATH_BUILDING_ENABLED) {
      next();
      return;
    }
    // The same exception and message as Nest's RoutesResolver not-found handler (express adapter).
    throw new NotFoundException(`Cannot ${req.method} ${req.originalUrl}`);
  }
}
