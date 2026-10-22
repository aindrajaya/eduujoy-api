import { type IncomingMessage, type ServerResponse } from 'node:http';
import { Module } from '@nestjs/common';
import { LoggerModule } from 'nestjs-pino';
import { AppConfig } from '../../config';
import { buildPinoOptions, REQUEST_ID_HEADER, requestLogProps, resolveRequestId, sanitizeUrl, serializeRequest } from './logger-options';

const QUIET_PATHS = new Set(['/health']);

@Module({
  imports: [
    LoggerModule.forRootAsync({
      inject: [AppConfig],
      useFactory: (config: AppConfig) => ({
        pinoHttp: {
          ...buildPinoOptions(config.env),
          genReqId: (req: IncomingMessage, res: ServerResponse) => {
            const id = resolveRequestId(req.headers[REQUEST_ID_HEADER]);
            res.setHeader('X-Request-Id', id);
            return id;
          },
          quietReqLogger: true,
          customProps: (req: IncomingMessage) => requestLogProps(req as Parameters<typeof requestLogProps>[0]),
          customAttributeKeys: { reqId: 'requestId', responseTime: 'latencyMs' },
          autoLogging: { ignore: (req: IncomingMessage) => QUIET_PATHS.has(sanitizeUrl(req.url)) },
          serializers: {
            req: serializeRequest,
            res: (res: { statusCode: number }) => ({ statusCode: res.statusCode }),
          },
        },
      }),
    }),
  ],
})
export class LoggingModule {}
