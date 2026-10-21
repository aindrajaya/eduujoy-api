import { type NestExpressApplication } from '@nestjs/platform-express';
import { Test } from '@nestjs/testing';
import { AppModule } from '../src/app.module';
import { configureApp } from '../src/shared/common/http';
import { AppConfig } from '../src/shared/config';

export type TestApp = NestExpressApplication;

export async function createTestApp(): Promise<TestApp> {
  const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
  const app = moduleRef.createNestApplication<TestApp>({ bodyParser: false });
  configureApp(app, app.get(AppConfig));
  await app.init();
  return app;
}
