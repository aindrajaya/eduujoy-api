import 'reflect-metadata';
import { existsSync } from 'node:fs';
import { NestFactory } from '@nestjs/core';
import { type NestExpressApplication } from '@nestjs/platform-express';
import { Logger } from 'nestjs-pino';
import { AppModule } from './app.module';
import { configureApp } from './shared/common/http';
import { AppConfig } from './shared/config';

async function bootstrap(): Promise<void> {
  // Local development only: production images ship without a .env and read the platform env.
  if (existsSync('.env')) process.loadEnvFile('.env');

  const app = await NestFactory.create<NestExpressApplication>(AppModule, {
    bufferLogs: true,
    bodyParser: false,
    // Keeps req.rawBody beside the parsed JSON: the billing webhook's HMAC is over the exact bytes.
    rawBody: true,
  });
  app.useLogger(app.get(Logger));
  app.enableShutdownHooks();

  const config = app.get(AppConfig);
  configureApp(app, config);
  await app.listen(config.env.PORT, '0.0.0.0');
}

void bootstrap();
