import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { Pool } from 'pg';
import { buildSmoke, ctx, env } from './runner';
import { ANALYSE_RESOURCE_JOB } from '../../src/modules/discovery/application/jobs';
import { pacificDay, type Stage, YOUTUBE_SEARCH_QUOTA, youtubeIdFromUrl } from '../../src/modules/discovery/domain';
import { guardPool, POOL_SETTINGS } from '../../src/shared/db/db.module';
import { loadDirectDatabaseUrl } from '../../src/shared/db/cli/env';
import { describeError } from '../../src/shared/db/redact';
import { inArray } from 'drizzle-orm';
import { resources } from '../../src/shared/db/schema/discovery';
import { topics } from '../../src/shared/db/schema/catalog';

// Run by the user: `pnpm discovery:smoke [--cap 5] [--topics 10] [--set a|b] [--skip-ready]` (node --env-file=.env), against
// eduujoy-dev after `pnpm db:migrate`. Real YouTube, OpenAlex, Claude web search and Gemini; every AI call
// is metered into llm_calls. Hard spend stop: no new discovery starts unless spent + 0.60 <= cap, and no
// new analysis unless spent + 0.10 <= cap. Analyse jobs run here, inline (never queued, so a running dev
// API cannot pick them up). Keys come from process.env only and are never printed or written.
// Writes the report to .smoke/ (git-ignored) and prints the summary the API lane needs for A8's
// Done-when: types per topic, dead links, searches, tokens and cost per discovery, and the mean.
// Wired by hand: tsx emits no decorator metadata, so Nest DI can't run under it.

const DISCOVERY_RESERVE_USD = 0.6;
const ANALYSIS_RESERVE_USD = 0.1;

/** Two sets of 10 fixture topics, each covering every domain and stage. */
const FIXTURES_A: { slug: string; stage: Stage }[] = [
  { slug: 'python', stage: 'novice' },
  { slug: 'react-hooks', stage: 'advanced_beginner' },
  { slug: 'kubernetes', stage: 'competent' },
  { slug: 'sql', stage: 'proficient' },
  { slug: 'linear-algebra', stage: 'competent' },
  { slug: 'organic-chemistry', stage: 'novice' },
  { slug: 'classical-mechanics', stage: 'expert' },
  { slug: 'photography', stage: 'advanced_beginner' },
  { slug: 'public-speaking', stage: 'novice' },
  { slug: 'microeconomics', stage: 'proficient' },
];

/**
 * Cards are cached per topic and prompt version, so a second run on set A mostly reuses them and costs
 * far less than a cold discovery. `--set b` measures cold cost on topics set A never touched.
 */
const FIXTURES_B: { slug: string; stage: Stage }[] = [
  { slug: 'javascript', stage: 'novice' },
  { slug: 'docker', stage: 'advanced_beginner' },
  { slug: 'git', stage: 'competent' },
  { slug: 'nosql-databases', stage: 'proficient' },
  { slug: 'machine-learning', stage: 'competent' },
  { slug: 'genetics', stage: 'novice' },
  { slug: 'probability', stage: 'expert' },
  { slug: 'drawing', stage: 'advanced_beginner' },
  { slug: 'investing-fundamentals', stage: 'novice' },
  { slug: 'world-history', stage: 'proficient' },
];

class SpendStop extends Error {
  override name = 'SpendStop';
}


function arg(name: string, fallback: string): string {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? (process.argv[i + 1] ?? fallback) : fallback;
}

async function main(): Promise<void> {
  const check = process.argv.includes('--check');
  const capUsd = Number(arg('cap', '5'));
  const set = arg('set', 'a');
  if (set !== 'a' && set !== 'b') throw new Error('--set must be a or b');
  const fixtures = set === 'a' ? FIXTURES_A : FIXTURES_B;
  const count = Number(arg('topics', String(fixtures.length)));
  if (!(capUsd > 0 && capUsd <= 5)) throw new Error('--cap must be above 0 and at most 5 (US$)');
  const keys = check
    ? { anthropic: 'check', gemini: 'check', youtube: 'check', openalex: 'check' }
    : { anthropic: env('ANTHROPIC_API_KEY'), gemini: env('GEMINI_API_KEY'), youtube: env('YOUTUBE_API_KEY'), openalex: env('OPENALEX_API_KEY') };
  // A guarded pool, like the API's: a dropped Neon connection is logged, its query fails, and the next
  // query gets a fresh connection, so a long run survives a drop (set B crashed on "read ETIMEDOUT").
  const client = guardPool(new Pool({ connectionString: check ? 'postgresql://check@localhost/check' : loadDirectDatabaseUrl(), ...POOL_SETTINGS }), (message) => {
    process.stderr.write(`discovery:smoke: ${message}\n`);
  });
  const smoke = buildSmoke(client, keys, capUsd);
  // `--check` proves the wiring builds under its runner (test/cli/cli-boot.int-spec.ts) without connecting.
  if (check) {
    process.stdout.write(`discovery:smoke: ok (${smoke.discover.constructor.name}, ${smoke.analyse.constructor.name})\n`);
    return;
  }

  const abort = new AbortController();
  const report: Record<string, unknown>[] = [];
  const failed: { topic: string; stage: Stage; error: string; costUsd: number }[] = [];
  const skipReady = process.argv.includes('--skip-ready');
  try {
    const slugs = fixtures.slice(0, count);
    const rows = await smoke.db.select({ id: topics.id, slug: topics.slug }).from(topics).where(inArray(topics.slug, slugs.map((f) => f.slug)));
    const ids = new Map(rows.map((r) => [r.slug, r.id]));
    for (const fixture of slugs) {
      const topicId = ids.get(fixture.slug);
      if (!topicId) throw new Error(`Topic ${fixture.slug} is not in the database; run pnpm db:seed first`);
      if (smoke.meter.total + DISCOVERY_RESERVE_USD > capUsd) throw new SpendStop(`stopping before ${fixture.slug}: $${smoke.meter.total.toFixed(4)} spent of the $${capUsd} cap`);
      const latest = await smoke.repo.latestPool(topicId, fixture.stage);
      if (skipReady && latest?.status === 'ready' && latest.expiresAt > new Date()) {
        process.stdout.write(`${fixture.slug} (${fixture.stage}): skipped, a ready pool exists (--skip-ready)\n`);
        continue;
      }
      smoke.meter.take();
      const started = Date.now();
      const poolVersion = (latest?.poolVersion ?? 0) + 1;
      try {
        // Operator scope: counted in neither daily budget; this script's cap is the stop.
        await smoke.discover.run(smoke.discover.parse({ topicId, stage: fixture.stage, poolVersion, budgetScope: 'operator' }), ctx(abort.signal));
        const jobs = smoke.queued.filter((q) => q.type === ANALYSE_RESOURCE_JOB).splice(0);
        smoke.queued.length = 0;
        let cachedOrReused = 0;
        for (const job of jobs) {
          if (smoke.meter.total + ANALYSIS_RESERVE_USD > capUsd) throw new SpendStop(`stopping inside ${fixture.slug}: $${smoke.meter.total.toFixed(4)} spent`);
          const outcome = await smoke.analyse.run(smoke.analyse.parse(job.payload), ctx(abort.signal));
          const result = outcome.result as { outcome?: string } | undefined;
          if (result?.outcome === 'cached' || result?.outcome === 'reused') cachedOrReused += 1;
        }
        const pool = await smoke.repo.findPool(topicId, fixture.stage, poolVersion);
        const served = pool?.resourceIds.length
          ? await smoke.db.select({ id: resources.id, url: resources.url, type: resources.type }).from(resources).where(inArray(resources.id, pool.resourceIds))
          : [];
        // Re-check every served link now: the Done-when is 0 dead links.
        let dead = 0;
        for (const r of served) {
          const id = youtubeIdFromUrl(r.url);
          const ok = id ? (await smoke.videos.details([id])).some((v) => v.public && v.embeddable) : (await smoke.links.check(r.url)).ok;
          if (!ok) dead += 1;
        }
        const calls = smoke.meter.take();
        const row = {
          topic: fixture.slug,
          stage: fixture.stage,
          pool: pool?.status ?? 'missing',
          candidates: pool?.candidateIds.length ?? 0,
          served: served.length,
          types: [...new Set(served.map((r) => r.type))].sort(),
          dead,
          cachedOrReused,
          videoFallback: pool?.videoFallback ?? false,
          webSearches: calls.reduce((n, c) => n + c.webSearchRequests, 0),
          inputTokens: calls.reduce((n, c) => n + c.usage.inputTokens + c.usage.cacheReadTokens, 0),
          outputTokens: calls.reduce((n, c) => n + c.usage.outputTokens, 0),
          costUsd: Math.round(calls.reduce((n, c) => n + c.costUsd, 0) * 1_000_000) / 1_000_000,
          discoverCostUsd: Math.round(calls.filter((c) => c.stage === 'discover').reduce((n, c) => n + c.costUsd, 0) * 1_000_000) / 1_000_000,
          failedCalls: calls.filter((c) => c.status !== 'ok').map((c) => `${c.stage}:${c.status}:${c.failure ?? ''}`),
          seconds: Math.round((Date.now() - started) / 1000),
        };
        report.push(row);
        process.stdout.write(
          `${row.topic} (${row.stage}): pool ${row.pool}, ${row.served}/${row.candidates} served, types ${row.types.join('/')}, dead ${row.dead}, ` +
            `searches ${row.webSearches}, tokens ${row.inputTokens}/${row.outputTokens}, cost $${row.costUsd} (web discovery $${row.discoverCostUsd})\n`,
        );
      } catch (error) {
        // A failed topic (for example a dropped connection mid-run) is recorded and the run goes on.
        if (error instanceof SpendStop) throw error;
        const calls = smoke.meter.take();
        const costUsd = Math.round(calls.reduce((n, c) => n + c.costUsd, 0) * 1_000_000) / 1_000_000;
        failed.push({ topic: fixture.slug, stage: fixture.stage, error: describeError(error), costUsd });
        process.stdout.write(`${fixture.slug} (${fixture.stage}): FAILED, ${describeError(error)} (cost $${costUsd})\n`);
      }
    }
  } catch (error) {
    if (!(error instanceof SpendStop)) throw error;
    process.stdout.write(`SPEND STOP: ${error.message}\n`);
  } finally {
    const done = report.length;
    const mean = (key: 'costUsd' | 'discoverCostUsd'): number => (done ? report.reduce((n, r) => n + (r[key] as number), 0) / done : 0);
    const used = await smoke.quota.used(YOUTUBE_SEARCH_QUOTA, pacificDay(new Date())).catch(() => -1);
    const summary = {
      at: new Date().toISOString(),
      set,
      topics: done,
      // Cards reused from an earlier run cost nothing; a cold measurement needs fresh topics (--set b).
      cachedOrReusedAnalyses: report.reduce((n, r) => n + (r['cachedOrReused'] as number), 0),
      atLeast3Types: report.filter((r) => (r['types'] as string[]).length >= 3).length,
      deadLinks: report.reduce((n, r) => n + (r['dead'] as number), 0),
      meanCostUsd: Math.round(mean('costUsd') * 1_000_000) / 1_000_000,
      meanWebDiscoveryCostUsd: Math.round(mean('discoverCostUsd') * 1_000_000) / 1_000_000,
      totalSpentUsd: Math.round(smoke.meter.total * 1_000_000) / 1_000_000,
      capUsd,
      youtubeSearchCallsToday: used,
      // Must be 0: an unrecorded call is spend the daily budget guard cannot see.
      recordFailures: smoke.meter.failures,
      failedTopics: failed,
    };
    const dir = join(__dirname, '..', '..', '.smoke');
    mkdirSync(dir, { recursive: true });
    const file = join(dir, `discovery-${summary.at.replace(/[:.]/g, '-')}.json`);
    writeFileSync(file, `${JSON.stringify({ summary, topics: report, failed }, null, 2)}\n`);
    process.stdout.write(`\n${JSON.stringify(summary)}\nReport: ${file}\n`);
    if (smoke.meter.failures > 0) {
      process.stderr.write(`discovery:smoke: ${smoke.meter.failures} llm_calls row(s) failed to record; the run's cost is not fully in llm_calls\n`);
      process.exitCode = 1;
    }
    await client.end();
  }
}

main().catch((error: unknown) => {
  process.stderr.write(`discovery:smoke failed: ${describeError(error)}\n`);
  process.exitCode = 1;
});
