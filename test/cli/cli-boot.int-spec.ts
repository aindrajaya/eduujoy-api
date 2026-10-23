import { execFile } from 'node:child_process';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { Test } from '@nestjs/testing';
import { EmbedTopics } from '../../src/modules/catalog/application/embed-topics.usecase';
import { CatalogModule } from '../../src/modules/catalog/catalog.module';
import { AiModule } from '../../src/shared/ai';
import { ConfigModule } from '../../src/shared/config';
import { DbModule } from '../../src/shared/db';
import { EventsModule } from '../../src/shared/events';

const run = promisify(execFile);
const ROOT = join(__dirname, '..', '..');

// Every CLI the user runs, under the same runner as its package script (tsx), in `--check` mode:
// it loads and wires everything, then exits without connecting or calling a provider.
const CLIS = [
  { script: 'db:migrate', file: 'src/shared/db/cli/migrate.ts', args: [], out: 'db:migrate: ok' },
  { script: 'db:seed', file: 'src/shared/db/cli/seed.ts', args: ['--dir', 'seed'], out: 'db:seed: ok (160 topics)' },
  { script: 'catalog:embed-topics', file: 'scripts/catalog/embed-topics.ts', args: [], out: 'catalog:embed-topics: ok (EmbedTopics)' },
  { script: 'billing:reprocess', file: 'scripts/billing/reprocess.ts', args: [], out: 'billing:reprocess: ok (ReprocessBillingEvent)' },
  { script: 'discovery:smoke', file: 'scripts/discovery/smoke.ts', args: [], out: 'discovery:smoke: ok (DiscoverResources, AnalyseResource)' },
  { script: 'discovery:verify-video', file: 'scripts/discovery/verify-video.ts', args: [], out: 'discovery:verify-video: ok (GeminiResourceAnalyzer)' },
  { script: 'eval:paths', file: 'scripts/eval/paths.ts', args: [], out: 'eval:paths: ok (ClaudePathDesigner v1, judge v1)' },
];

describe('CLI boot (integration)', () => {
  it.each(CLIS)('$script loads and wires under tsx', async ({ file, args, out }) => {
    const { stdout } = await run(process.execPath, ['--import', 'tsx', file, ...args, '--check'], { cwd: ROOT, env: { ...process.env, LOG_LEVEL: 'silent' } });

    expect(stdout.trim()).toBe(out);
  }, 60_000);

  it('boots a Nest context with the database but without the HTTP health stack', async () => {
    // A worker or CLI context: no HealthModule, so no ReadinessRegistry (the A6 embed-topics boot failure).
    for (const [name, value] of Object.entries({
      APP_ORIGIN: 'http://localhost:5173',
      API_PUBLIC_URL: 'http://localhost:3000',
      JWT_ACCESS_SECRET: 'int-access-secret-'.padEnd(64, 'x'),
      REFRESH_TOKEN_PEPPER: 'int-refresh-pepper-'.padEnd(64, 'y'),
      GOOGLE_OAUTH_CLIENT_ID: 'int.apps.googleusercontent.com',
      GOOGLE_OAUTH_CLIENT_SECRET: 'int-google-secret',
      GOOGLE_OAUTH_REDIRECT_URI: 'http://localhost:3000/v1/auth/google/callback',
      ANTHROPIC_API_KEY: 'int-anthropic-key',
      GEMINI_API_KEY: 'int-gemini-key',
      AI_DAILY_BUDGET_USD: '1',
      AI_DAILY_PAID_BUDGET_USD: '5',
      LEMONSQUEEZY_API_KEY: 'int-lemonsqueezy-key',
      LEMONSQUEEZY_STORE_ID: '100001',
      LEMONSQUEEZY_WEBHOOK_SECRET: 'int-webhook-secret-'.padEnd(40, 'z'),
      LEMONSQUEEZY_VARIANT_SUBSCRIPTION: '200001',
      LEMONSQUEEZY_VARIANT_CREDIT_PACK: '200002',
      LEMONSQUEEZY_MODE: 'test',
      YOUTUBE_API_KEY: 'test-youtube-key',
      OPENALEX_API_KEY: 'test-openalex-key',
    })) {
      process.env[name] ??= value;
    }
    const moduleRef = await Test.createTestingModule({ imports: [ConfigModule.forRoot(), DbModule, EventsModule, AiModule, CatalogModule] }).compile();
    await moduleRef.init();
    try {
      expect(moduleRef.get(EmbedTopics)).toBeInstanceOf(EmbedTopics);
    } finally {
      await moduleRef.close();
    }
  });
});
