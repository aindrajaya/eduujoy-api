import { type NestExpressApplication } from '@nestjs/platform-express';
import cookieParser from 'cookie-parser';
import helmet from 'helmet';
import { type AppConfig } from '../../config';

export const BODY_LIMIT = '256kb';
export const CORS_ALLOWED_HEADERS = [
  'Content-Type',
  'X-Requested-With',
  'X-Request-Id',
  'Idempotency-Key',
  'If-None-Match',
  'Last-Event-ID',
];

/** HTTP hardening shared by main.ts and the e2e harness, so tests exercise the real stack. */
export function configureApp(app: NestExpressApplication, config: AppConfig): void {
  const allowed = new Set(config.env.APP_ORIGIN);

  app.disable('x-powered-by');
  // Koyeb terminates TLS at one proxy hop; this makes req.ip and req.secure reflect the client.
  app.set('trust proxy', 1);
  app.use(helmet());
  app.use(cookieParser());
  app.useBodyParser('json', { limit: BODY_LIMIT });
  app.useBodyParser('urlencoded', { limit: BODY_LIMIT, extended: false });
  app.enableCors({
    origin: (origin, callback) => {
      callback(null, origin !== undefined && allowed.has(origin));
    },
    credentials: true,
    methods: ['GET', 'POST', 'PATCH', 'DELETE'],
    allowedHeaders: CORS_ALLOWED_HEADERS,
    exposedHeaders: ['X-Request-Id'],
    maxAge: 600,
  });
}
