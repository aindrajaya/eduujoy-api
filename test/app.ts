import { type NestExpressApplication } from '@nestjs/platform-express';
import { Test, type TestingModuleBuilder } from '@nestjs/testing';
import { AppModule } from '../src/app.module';
import { FakeBillingProvider } from '../src/modules/billing/application/billing.fakes';
import { BILLING_PROVIDER } from '../src/modules/billing/application/ports/billing-provider';
import { FakeLinkChecker, FakePaperSearch, FakeResourceAnalyzer, FakeVideoSearch, FakeWebDiscovery } from '../src/modules/discovery/application/discovery.fakes';
import { LINK_CHECKER } from '../src/modules/discovery/application/ports/link-checker';
import { PAPER_SEARCH } from '../src/modules/discovery/application/ports/paper-search';
import { RESOURCE_ANALYZER } from '../src/modules/discovery/application/ports/resource-analyzer';
import { VIDEO_SEARCH } from '../src/modules/discovery/application/ports/video-search';
import { WEB_DISCOVERY } from '../src/modules/discovery/application/ports/web-discovery';
import { FakePathDesigner } from '../src/modules/pathing/application/pathing.fakes';
import { PATH_DESIGNER } from '../src/modules/pathing/application/ports/path-designer';
import { EMBEDDER, STRUCTURED_GENERATOR, WEB_SEARCHER } from '../src/shared/ai';
import { configureApp } from '../src/shared/common/http';
import { AppConfig } from '../src/shared/config';

export type TestApp = NestExpressApplication;

const unexpected = (adapter: string) => () =>
  Promise.reject(new Error(`Unexpected ${adapter} call in e2e: override it in this spec (createTestApp(builder => ...))`));

/**
 * Every outbound adapter is faked by default, so no suite's app (or its job executor) can reach a real
 * provider: AI generation, embeddings, web search, Lemon Squeezy, and discovery's YouTube, OpenAlex, link and analysis adapters. Specs override the ones they exercise. Google
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
    .useValue(new FakeBillingProvider())
    // Discovery (A8): a placement enqueues discover-resources; these find nothing, so its pool is thin.
    .overrideProvider(VIDEO_SEARCH)
    .useValue(new FakeVideoSearch())
    .overrideProvider(WEB_DISCOVERY)
    .useValue(new FakeWebDiscovery())
    .overrideProvider(PAPER_SEARCH)
    .useValue(new FakePaperSearch())
    .overrideProvider(LINK_CHECKER)
    .useValue(new FakeLinkChecker(null))
    .overrideProvider(RESOURCE_ANALYZER)
    .useValue(new FakeResourceAnalyzer())
    .overrideProvider(PATH_DESIGNER)
    .useValue(new FakePathDesigner());
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
