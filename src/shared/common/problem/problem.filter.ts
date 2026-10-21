import { type ArgumentsHost, Catch, type ExceptionFilter, HttpException, Logger } from '@nestjs/common';
import { type Request, type Response } from 'express';
import { AppConfig } from '../../config';
import { sanitizeUrl } from '../logging/logger-options';
import { toProblem } from './problem';

/** Every error leaves the API as application/problem+json (PRD-API §7). */
@Catch()
export class ProblemFilter implements ExceptionFilter {
  private readonly logger = new Logger(ProblemFilter.name);

  constructor(private readonly config: AppConfig) {}

  catch(exception: unknown, host: ArgumentsHost): void {
    const http = host.switchToHttp();
    const req = http.getRequest<Request>();
    const res = http.getResponse<Response>();
    const problem = toProblem(exception, {
      baseUrl: this.config.env.API_PUBLIC_URL,
      requestId: typeof req.id === 'string' ? req.id : '',
      instance: sanitizeUrl(req.originalUrl),
    });

    if (problem.status >= 500) {
      const error = exception instanceof Error ? exception : new Error(String(exception));
      this.logger.error({ err: error, requestId: problem.body.requestId }, 'Unhandled error');
    } else if (!(exception instanceof HttpException)) {
      this.logger.warn({ requestId: problem.body.requestId }, 'Non-HTTP error mapped to a client problem');
    }

    if (res.headersSent) return;
    res.status(problem.status).set(problem.headers).type('application/problem+json').json(problem.body);
  }
}
