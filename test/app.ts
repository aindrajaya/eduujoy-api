import { type NestExpressApplication } from '@nestjs/platform-express';
import { Test, type TestingModuleBuilder } from '@nestjs/testing';
import { AppModule } from '../src/app.module';
import { FakeBillingProvider } from '../src/modules/billing/application/billing.fakes';
import { BILLING_PROVIDER } from '../src/modules/billing/application/ports/billing-provider';
import { EMBEDDER, STRUCTURED_GENERATOR, WEB_SEARCHER } from '../src/shared/ai';
import { configureApp } from '../src/shared/common/http';
import { AppConfig } from '../src/shared/config';

export type TestApp = NestExpressApplication;

const unexpected = (adapter: string) => () =>
  Promise.reject(new Error(`Unexpected ${adapter} call in e2e: override it in this spec (createTestApp(builder => ...))`));

/**
 * Every outbound adapter is faked by default, so no suite's app (or its job executor) can reach a real
 * provider: AI generation, embeddings, web search and Lemon Squeezy. Specs override the ones they exercise. Google
 * OAuth keeps its real client (building the authorize URL is local; google-auth.e2e-spec fakes the token
 * exchange), and the global fetch guard (test/setup-network.ts) blocks any request that slips past.
 */
function withOutboundFakes(builder: TestingModuleBuilder): TestingModuleBuilder {
  return builder
    .overrideProvider(STRUCTURED_GENERATOR)
    .useValue({ generate: unexpected('structured AI') })
    .overrideProvider(EMBEDDER)
    .useValue({ embed: unexpected('embedding') })
    .overrideProvider(WEB_SEARCHER)
    .useValue({ search: unexpected('web search') })
    .overrideProvider(BILLING_PROVIDER)
    .useValue(new FakeBillingProvider());
}

/** Boots the real app stack; `override` swaps providers (for example external clients) for fakes. */
export async function createTestApp(
  override: (builder: TestingModuleBuilder) => TestingModuleBuilder = (builder) => builder,
): Promise<TestApp> {
  const moduleRef = await override(withOutboundFakes(Test.createTestingModule({ imports: [AppModule] }))).compile();
  const app = moduleRef.createNestApplication<TestApp>({ bodyParser: false, rawBody: true });
  configureApp(app, app.get(AppConfig));
  await app.init();
  return app;
}
