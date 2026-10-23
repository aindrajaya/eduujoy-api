import { Client } from 'pg';
import { loadDirectDatabaseUrl } from '../../src/shared/db/cli/env';
import { guardConnection } from '../../src/shared/db/cli/guard';
import { describeError } from '../../src/shared/db/redact';

// `pnpm db:audit [--prod] [--since 2026-10-23T03:15:00Z]`: a read-only inventory of what local runs may
// have left in a database (user request, 23 Oct 2026, after api/.env pointed at eduujoy-prod from 10:15
// WIB). The session is read only (default_transaction_read_only), and it prints counts and non-personal
// labels only: job types, topic slugs with test prefixes, pool topics and stages, llm_calls by scope.
// No user rows, emails, names, goals or answers. Against prod: run it with DATABASE_URL_DIRECT set to
// the prod direct URL for that one command, plus --prod.

/** Job types the API registers; anything else in `jobs` came from a test or a script. */
const KNOWN_JOBS = ['discover-resources', 'analyse-resource', 'liveness-sweep', 'check-liveness', 'billing-event', 'generate-path', 'path-refund-sweep'];
/** Slug prefixes test fixtures use (seed topics such as test-driven-development are excluded). */
const TEST_SLUGS = ['path-', 'cards-', 'disc-', 'sse-', 'test-', 'golden-'];

function arg(name: string, fallback: string): string {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? (process.argv[i + 1] ?? fallback) : fallback;
}

async function main(): Promise<void> {
  if (process.argv.includes('--check')) {
    process.stdout.write('db:audit: ok\n');
    return;
  }
  const since = new Date(arg('since', '2026-10-23T03:15:00Z'));
  if (Number.isNaN(since.getTime())) throw new Error('--since must be an ISO time');
  const client = guardConnection(new Client({ connectionString: loadDirectDatabaseUrl(), options: '-c default_transaction_read_only=on' }), 'db:audit');
  await client.connect();
  const rows = async (sql: string, params: unknown[] = []): Promise<Record<string, unknown>[]> => (await client.query(sql, params)).rows as Record<string, unknown>[];
  const section = (title: string, value: unknown): void => {
    process.stdout.write(`\n## ${title}\n${JSON.stringify(value, null, 1)}\n`);
  };
  try {
    const [ro] = await rows(`show transaction_read_only`);
    process.stdout.write(`Read-only session: ${String(ro?.['transaction_read_only'])}; window since ${since.toISOString()}\n`);

    section('users (counts only)', (await rows(
      `select count(*)::int as total, count(*) filter (where email like '%@example.com')::int as example_com,
              count(*) filter (where created_at >= $1)::int as created_in_window from users`, [since]))[0]);
    section('topics by origin', await rows(`select origin, count(*)::int as n from topics group by origin order by origin`));
    section('topics with test-fixture slug prefixes', await rows(
      `select slug, origin, created_at from topics where origin <> 'seed' and (${TEST_SLUGS.map((_, i) => `slug like $${i + 1}`).join(' or ')}) order by created_at`,
      TEST_SLUGS.map((p) => `${p}%`)));
    section('jobs by type and status', await rows(
      `select type, status, count(*)::int as n, (type <> all($1::text[])) as unknown_type, min(created_at) as first, max(created_at) as last
         from jobs group by type, status order by type, status`, [KNOWN_JOBS]));
    section('llm_calls by scope, stage and day', await rows(
      `select budget_scope, stage, to_char(created_at at time zone 'UTC', 'YYYY-MM-DD') as day_utc, count(*)::int as n,
              count(*) filter (where job_id is null)::int as no_job, round(sum(cost_usd)::numeric, 4) as usd
         from llm_calls group by 1, 2, 3 order by 3, 1, 2`));
    section('discovery pools created in the window', await rows(
      `select t.slug, d.stage, d.status, cardinality(d.resource_ids) as served, d.created_at
         from discovery_results d join topics t on t.id = d.topic_id where d.created_at >= $1 order by d.created_at`, [since]));
    section('discovery pools before the window', (await rows(
      `select count(*)::int as n, min(created_at) as first, max(created_at) as last from discovery_results where created_at < $1`, [since]))[0]);
    section('resources (example.com URLs are test fixtures)', (await rows(
      `select count(*)::int as total, count(*) filter (where url like 'https://example.com/%')::int as example_com,
              count(*) filter (where created_at >= $1)::int as created_in_window from resources`, [since]))[0]);
    section('YouTube quota counter', await rows(`select quota, to_char(day, 'YYYY-MM-DD') as day, used, updated_at from provider_quota_usage order by day`));
    section('review items by kind and reason', await rows(`select kind, reason, status, count(*)::int as n from review_items group by 1, 2, 3 order by 1, 2`));
    section('credit ledger by reason (counts only)', await rows(
      `select reason, count(*)::int as n, count(*) filter (where created_at >= $1)::int as in_window from credit_ledger group by reason order by reason`, [since]));
    section('test schemas (test_*)', (await rows(`select count(*)::int as n from information_schema.schemata where schema_name like 'test\\_%'`))[0]);
  } finally {
    await client.end();
  }
}

main().catch((error: unknown) => {
  process.stderr.write(`db:audit failed: ${describeError(error)}\n`);
  process.exitCode = 1;
});
