import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { inArray } from 'drizzle-orm';
import { Pool } from 'pg';
import { z } from 'zod';
import { ANALYSE_RESOURCE_JOB } from '../../src/modules/discovery/application/jobs';
import { pacificDay, STAGES, type Stage, YOUTUBE_SEARCH_GUARD, YOUTUBE_SEARCH_QUOTA } from '../../src/modules/discovery/domain';
import { loadDirectDatabaseUrl } from '../../src/shared/db/cli/env';
import { guardPool, POOL_SETTINGS } from '../../src/shared/db/db.module';
import { describeError } from '../../src/shared/db/redact';
import { topics } from '../../src/shared/db/schema/catalog';
import { ANALYSIS_RESERVE_USD, coldPoolsToday, poolStop, SEARCHES_PER_POOL } from './pregen-rules';
import { buildSmoke, ctx, env } from './runner';

// Run by the user 1-3 days before beta, then every 30 days (YouTube's 30-day storage limit); D1 (user,
// 23 Oct 2026): `pnpm discovery:pregen [--topics scripts/discovery/pregen-topics.json]
// [--stages novice,advanced_beginner] [--cap 35] [--youtube-reserve 20] [--dry-run]`.
// - Builds the shared topic + stage pools learners would otherwise pay for cold, metered under budget
//   scope `operator` (counted in neither daily budget) with its own hard stop: no pool starts unless
//   spent + 0.60 <= cap, and no analysis unless spent + 0.10 <= cap (in-memory tally first, like the smoke).
// - Resumable and idempotent: ready, unexpired pools are skipped; a pool left analysing by an interrupted
//   run gets its remaining analyses; re-running the same command continues where it stopped.
// - YouTube: each pool makes 2 search.list calls. The run stops cleanly while `--youtube-reserve` (20)
//   of the daily guard (90) is still free for live learners, and says to resume tomorrow (Pacific day).
// - Prints the measured mean cost per new pool: the post-cap re-measure D1 asks for.
// - `--dry-run` lists what would run and the estimated cost, without AI calls; `--check` only proves the
//   wiring loads (no database). A real run needs the topic file's `approved: true`.

/** Post-cap estimate per cold pool (EXECUTION-PLAN §8 D1); replaced by this run's own measurement. */
const ESTIMATED_POOL_USD = 0.3;

const topicFile = z.object({ version: z.literal(1), approved: z.boolean(), topics: z.array(z.string().min(1)).min(1) }).loose();

class Stop extends Error {
  override name = 'Stop';
}

function arg(name: string, fallback: string): string {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? (process.argv[i + 1] ?? fallback) : fallback;
}

type Plan = { slug: string; stage: Stage; action: 'skip-ready' | 'resume' | 'cold'; topicId: string; poolVersion: number };

async function main(): Promise<void> {
  const check = process.argv.includes('--check');
  const dryRun = process.argv.includes('--dry-run');
  const capUsd = Number(arg('cap', '35'));
  const reserve = Number(arg('youtube-reserve', '20'));
  const stages = arg('stages', 'novice,advanced_beginner').split(',').map((s) => s.trim());
  if (stages.some((s) => !(STAGES as readonly string[]).includes(s))) throw new Error(`--stages must be among ${STAGES.join(', ')}`);
  if (!(capUsd > 0 && capUsd <= 50)) throw new Error('--cap must be above 0 and at most 50 (US$)');
  if (!(reserve >= 0 && reserve < YOUTUBE_SEARCH_GUARD)) throw new Error(`--youtube-reserve must be 0 to ${YOUTUBE_SEARCH_GUARD - 1}`);
  const file = topicFile.parse(JSON.parse(readFileSync(resolve(arg('topics', join(__dirname, 'pregen-topics.json'))), 'utf8')));
  if (!check && !dryRun && !file.approved) throw new Error('The topic file is not approved yet (approved: false); review it, or use --dry-run');

  const keys = check || dryRun
    ? { anthropic: 'check', gemini: 'check', youtube: 'check', openalex: 'check' }
    : { anthropic: env('ANTHROPIC_API_KEY'), gemini: env('GEMINI_API_KEY'), youtube: env('YOUTUBE_API_KEY'), openalex: env('OPENALEX_API_KEY') };
  const pool = guardPool(new Pool({ connectionString: check ? 'postgresql://check@localhost/check' : loadDirectDatabaseUrl(), ...POOL_SETTINGS }), (message) => {
    process.stderr.write(`discovery:pregen: ${message}\n`);
  });
  const run = buildSmoke(pool, keys, capUsd);
  if (check) {
    process.stdout.write(`discovery:pregen: ok (${file.topics.length} topics x ${stages.length} stages)\n`);
    return;
  }

  const report: Record<string, unknown>[] = [];
  let stopped: string | null = null;
  try {
    const rows = await run.db.select({ id: topics.id, slug: topics.slug }).from(topics).where(inArray(topics.slug, file.topics));
    const ids = new Map(rows.map((r) => [r.slug, r.id]));
    const missing = file.topics.filter((s) => !ids.has(s));
    if (missing.length) throw new Error(`Topics not in the database: ${missing.join(', ')}`);

    const plans: Plan[] = [];
    const now = new Date();
    for (const slug of file.topics) {
      for (const stage of stages as Stage[]) {
        const topicId = ids.get(slug) as string;
        const latest = await run.repo.latestPool(topicId, stage);
        const fresh = latest !== null && latest.expiresAt > now;
        const action: Plan['action'] = fresh && latest.status === 'analysing' ? 'resume' : fresh ? 'skip-ready' : 'cold';
        plans.push({ slug, stage, action, topicId, poolVersion: action === 'cold' ? (latest?.poolVersion ?? 0) + 1 : (latest?.poolVersion ?? 1) });
      }
    }
    const day = pacificDay(now);
    const used = await run.quota.used(YOUTUBE_SEARCH_QUOTA, day);
    const cold = plans.filter((p) => p.action === 'cold');
    const allowedToday = coldPoolsToday(used, YOUTUBE_SEARCH_GUARD, reserve);
    process.stdout.write(
      `Plan: ${plans.length} pools; ${plans.filter((p) => p.action === 'skip-ready').length} ready (skipped), ${plans.filter((p) => p.action === 'resume').length} to resume, ${cold.length} cold. ` +
        `Estimated cost about $${(cold.length * ESTIMATED_POOL_USD).toFixed(2)} (cap $${capUsd}). YouTube search.list today (${day} PT): ${used} used, room for ${allowedToday} cold pools with ${reserve} kept for learners` +
        `${cold.length > allowedToday ? `, so about ${Math.ceil(cold.length / Math.max(1, Math.floor((YOUTUBE_SEARCH_GUARD - reserve) / SEARCHES_PER_POOL)))} days in all` : ''}.\n`,
    );
    if (dryRun) {
      for (const p of plans) process.stdout.write(`  ${p.action.padEnd(10)} ${p.slug} (${p.stage})\n`);
      return;
    }

    const abort = new AbortController();
    for (const p of plans) {
      if (p.action === 'skip-ready') continue;
      const searchesUsed = p.action === 'cold' ? await run.quota.used(YOUTUBE_SEARCH_QUOTA, pacificDay(new Date())) : 0;
      const stop = poolStop({ spentUsd: run.meter.total, capUsd, cold: p.action === 'cold', searchesUsed, guard: YOUTUBE_SEARCH_GUARD, reserve });
      if (stop) throw new Stop(stop);
      run.meter.take();
      const started = Date.now();
      try {
        if (p.action === 'cold') {
          await run.discover.run(run.discover.parse({ topicId: p.topicId, stage: p.stage, poolVersion: p.poolVersion, budgetScope: 'operator' }), ctx(abort.signal));
        }
        const jobs = run.queued.filter((q) => q.type === ANALYSE_RESOURCE_JOB).splice(0);
        run.queued.length = 0;
        if (p.action === 'resume') {
          // An interrupted run left this pool analysing: analyse what it did not reach (abstracts are
          // refetched as page text; already analysed resources are skipped by the handler).
          const open = await run.repo.findPool(p.topicId, p.stage, p.poolVersion);
          for (const resourceId of open ? open.candidateIds.filter((id) => !open.analysedIds.includes(id)) : []) {
            jobs.push({ type: ANALYSE_RESOURCE_JOB, idempotencyKey: `${open?.id ?? ''}:${resourceId}`, payload: { poolId: open?.id, resourceId, topicId: p.topicId, stage: p.stage, abstract: null, budgetScope: 'operator' } });
          }
        }
        for (const job of jobs) {
          if (run.meter.total + ANALYSIS_RESERVE_USD > capUsd) throw new Stop(`spend: $${run.meter.total.toFixed(4)} of the $${capUsd} cap, inside ${p.slug} (${p.stage}); resume with a higher --cap`);
          await run.analyse.run(run.analyse.parse(job.payload), ctx(abort.signal));
        }
        const settled = await run.repo.findPool(p.topicId, p.stage, p.poolVersion);
        const calls = run.meter.take();
        const row = {
          topic: p.slug,
          stage: p.stage,
          action: p.action,
          pool: settled?.status ?? 'missing',
          served: settled?.resourceIds.length ?? 0,
          costUsd: Math.round(calls.reduce((n, c) => n + c.costUsd, 0) * 1_000_000) / 1_000_000,
          seconds: Math.round((Date.now() - started) / 1000),
        };
        report.push(row);
        process.stdout.write(`${row.topic} (${row.stage}): ${row.action}, pool ${row.pool}, ${row.served} served, $${row.costUsd}\n`);
      } catch (error) {
        if (error instanceof Stop) throw error;
        const calls = run.meter.take();
        const costUsd = Math.round(calls.reduce((n, c) => n + c.costUsd, 0) * 1_000_000) / 1_000_000;
        report.push({ topic: p.slug, stage: p.stage, action: p.action, error: describeError(error), costUsd });
        process.stdout.write(`${p.slug} (${p.stage}): FAILED, ${describeError(error)} ($${costUsd}); re-run to retry\n`);
      }
    }
  } catch (error) {
    if (!(error instanceof Stop)) throw error;
    stopped = error.message;
    process.stdout.write(`STOPPED: ${error.message}\n`);
  } finally {
    if (!dryRun) {
      const coldDone = report.filter((r) => r['action'] === 'cold' && !r['error']);
      const summary = {
        at: new Date().toISOString(),
        poolsBuilt: report.filter((r) => !r['error']).length,
        failed: report.filter((r) => r['error']).length,
        stopped,
        // The D1 re-measure: mean cost of a cold pool after the analysis cap.
        meanCostPerColdPoolUsd: coldDone.length ? Math.round((coldDone.reduce((n, r) => n + (r['costUsd'] as number), 0) / coldDone.length) * 1_000_000) / 1_000_000 : null,
        totalSpentUsd: Math.round(run.meter.total * 1_000_000) / 1_000_000,
        capUsd,
        recordFailures: run.meter.failures,
      };
      const dir = join(__dirname, '..', '..', '.smoke');
      mkdirSync(dir, { recursive: true });
      const out = join(dir, `pregen-${summary.at.replace(/[:.]/g, '-')}.json`);
      writeFileSync(out, `${JSON.stringify({ summary, pools: report }, null, 2)}\n`);
      process.stdout.write(`\n${JSON.stringify(summary)}\nReport: ${out}\n`);
      if (run.meter.failures > 0) process.exitCode = 1;
    }
    await pool.end();
  }
}

main().catch((error: unknown) => {
  process.stderr.write(`discovery:pregen failed: ${describeError(error)}\n`);
  process.exitCode = 1;
});
