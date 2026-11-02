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
  { script: 'db:seed', file: 'src/shared/db/cli/seed.ts', args: ['--dir', 'seed'], out: 'db:seed: ok (160 topics, 160 concept maps)' },
  { script: 'db:audit', file: 'scripts/ops/audit-db.ts', args: [], out: 'db:audit: ok' },
  { script: 'catalog:embed-topics', file: 'scripts/catalog/embed-topics.ts', args: [], out: 'catalog:embed-topics: ok (EmbedTopics)' },
  { script: 'billing:reprocess', file: 'scripts/billing/reprocess.ts', args: [], out: 'billing:reprocess: ok (ReprocessBillingEvent)' },
  { script: 'discovery:smoke', file: 'scripts/discovery/smoke.ts', args: [], out: 'discovery:smoke: ok (DiscoverResources, AnalyseResource)' },
  { script: 'discovery:verify-video', file: 'scripts/discovery/verify-video.ts', args: [], out: 'discovery:verify-video: ok (GeminiResourceAnalyzer)' },
  { script: 'discovery:pregen', file: 'scripts/discovery/pregen.ts', args: [], out: 'discovery:pregen: ok (50 topics, 150 pools)' },
  { script: 'discovery:pregen (per-topic stages)', file: 'scripts/discovery/pregen.ts', args: ['--topics', 'test/fixtures/pregen/per-topic-stages.json'], out: 'discovery:pregen: ok (2 topics, 4 pools)' },
  { script: 'eval:paths', file: 'scripts/eval/paths.ts', args: [], out: 'eval:paths: ok (ClaudePathDesigner v5, judge v3)' },
];

describe('CLI boot (integration)', () => {
  it.each(CLIS)('$script loads and wires under tsx', async ({ file, args, out }) => {
    const { stdout } = await run(process.execPath, ['--import', 'tsx', file, ...args, '--check'], { cwd: ROOT, env: { ...process.env, LOG_LEVEL: 'silent' } });

    expect(stdout.trim()).toEqual(out);
  }, 60_000);

  // `--prod` must parse in every CLI (db:seed's strict parser rejected it before 2 Nov 2026).
  it.each(CLIS)('$script accepts --prod', async ({ file, args, out }) => {
    const { stdout } = await run(process.execPath, ['--import', 'tsx', file, ...args, '--prod', '--check'], { cwd: ROOT, env: { ...process.env, LOG_LEVEL: 'silent' } });

    expect(stdout.trim()).toEqual(out);
  }, 60_000);

  // User decision (23 Oct 2026): every CLI that connects refuses eduujoy-prod unless `--prod` is passed.
  // A fake prod URL (nothing listens there) and fake keys get each script to its database step.
  const PROD_REFUSALS = [
    ['src/shared/db/cli/migrate.ts'],
    ['src/shared/db/cli/seed.ts', '--dir', 'seed'],
    ['scripts/ops/audit-db.ts'],
    ['scripts/catalog/embed-topics.ts'],
    ['scripts/billing/reprocess.ts', '00000000-0000-4000-8000-000000000000'],
    ['scripts/discovery/smoke.ts'],
    ['scripts/discovery/verify-video.ts'],
    ['scripts/discovery/pregen.ts', '--dry-run'],
    ['scripts/eval/paths.ts', '--dry-run'],
  ];
  it.each(PROD_REFUSALS)('%s refuses the prod database without --prod', async (file, ...args) => {
    const env = {
      ...process.env,
      LOG_LEVEL: 'silent',
      DATABASE_URL_DIRECT: 'postgresql://u:p@ep-raspy-recipe-bamuza67.c-8.eu-central-1.aws.neon.tech/neondb',
      ANTHROPIC_API_KEY: 'x',
      GEMINI_API_KEY: 'x',
      YOUTUBE_API_KEY: 'x',
      OPENALEX_API_KEY: 'x',
    };
    const failed = await run(process.execPath, ['--import', 'tsx', file, ...args], { cwd: ROOT, env }).then(
      () => null,
      (error: unknown) => error as { stderr?: string },
    );

    expect(failed?.stderr).toContain('Target database: ep-raspy-recipe-bamuza67 (c-8.eu-central-1) [PROD]');
    expect(failed?.stderr).toContain('Refusing the prod database ep-raspy-recipe-bamuza67: pass --prod');
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
