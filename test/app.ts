import { type NestExpressApplication } from '@nestjs/platform-express';
import { Test, type TestingModuleBuilder } from '@nestjs/testing';
import { AppModule } from '../src/app.module';
import { configureApp } from '../src/shared/common/http';
import { AppConfig } from '../src/shared/config';

export type TestApp = NestExpressApplication;

/** Boots the real app stack; `override` swaps providers (for example external clients) for fakes. */
export async function createTestApp(
  override: (builder: TestingModuleBuilder) => TestingModuleBuilder = (builder) => builder,
): Promise<TestApp> {
  const moduleRef = await override(Test.createTestingModule({ imports: [AppModule] })).compile();
  const app = moduleRef.createNestApplication<TestApp>({ bodyParser: false });
  configureApp(app, app.get(AppConfig));
  await app.init();
  return app;
}
