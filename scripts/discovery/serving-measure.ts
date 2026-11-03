import { Logger } from '@nestjs/common';
import { sql } from 'drizzle-orm';
import { Client } from 'pg';
import { ServedCardsQuery } from '../../src/modules/discovery/application/served-cards.query';
import { DrizzleCardReader } from '../../src/modules/discovery/infrastructure/drizzle-card.reader';
import { type Stage } from '../../src/modules/discovery/domain';
import { GetConceptMapQuery } from '../../src/modules/catalog/application/get-concept-map.query';
import { DrizzleConceptMapReader } from '../../src/modules/catalog/infrastructure/drizzle-concept-map.reader';
import { type ConceptMap, conceptMatches } from '../../src/shared/common/concept-map';
import { createDatabase } from '../../src/shared/db';
import { loadDirectDatabaseUrl } from '../../src/shared/db/cli/env';
import { describeError } from '../../src/shared/db/redact';

// Usage: pnpm discovery:serving-measure [--pools python:novice,sql:expert] [--prod]
// Read-only (the session is set read-only): for each latest pool, the analysed cards against what the
// serving rules serve (domain serving-rules), why the rest are held back, the pool's coverage of its
// stage's map concepts, and the pools under the served minimum. The A8 pilot's before and after
// (lead, 3 Nov 2026) both use this reader. Maps come from topic_concept_maps, like the app.

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

/** Share of the pool stage's own map concepts that at least one served card teaches. */
function coverage(map: ConceptMap | null, stage: string, cards: { concepts: { name: string }[] }[]): string {
  const concepts = map?.stages.find((s) => s.stage === stage)?.concepts ?? [];
  if (concepts.length === 0) return '-';
  const taught = concepts.filter((c) => cards.some((card) => card.concepts.some((k) => conceptMatches(k.name, [c.name, ...c.aliases]))));
  return `${taught.length}/${concepts.length}`;
}

async function main(): Promise<void> {
  // The table carries the flags; the query's own warnings would only repeat them.
  Logger.overrideLogger(false);
  const client = new Client({ connectionString: loadDirectDatabaseUrl() });
  await client.connect();
  try {
    await client.query('SET default_transaction_read_only = on');
    const db = createDatabase(client);
    const wanted = arg('pools')?.split(',').filter(Boolean);
    const pools = await db.execute<{ topic_id: string; slug: string; stage: Stage }>(
      sql`SELECT DISTINCT d.topic_id, t.slug, d.stage FROM discovery_results d JOIN topics t ON t.id = d.topic_id WHERE d.status <> 'analysing' ORDER BY t.slug, d.stage`,
    );
    const rows = pools.rows.filter((p) => !wanted || wanted.includes(`${p.slug}:${p.stage}`));
    const maps = new GetConceptMapQuery(new DrizzleConceptMapReader(db));
    const reader = new DrizzleCardReader(db);
    const served = new ServedCardsQuery(reader, maps);
    let analysed = 0;
    let kept = 0;
    const under: string[] = [];
    for (const p of rows) {
      const latest = await reader.latestPool(p.topic_id, p.stage);
      const all = latest ? await reader.cards(p.topic_id, latest.resourceIds, false) : [];
      const out = await served.pool(p.topic_id, p.stage);
      const map = await maps.execute(p.topic_id);
      analysed += all.length;
      kept += out.cards.length;
      const d = out.held?.dropped;
      if (out.held?.flagged) under.push(`${p.slug}:${p.stage} (refilled ${out.held.refilled})`);
      process.stdout.write(
        `${`${p.slug}:${p.stage}`.padEnd(44)} analysed ${String(all.length).padStart(2)}  served ${String(out.cards.length).padStart(2)}  ` +
          `held: page ${d?.page_kind ?? 0}, stage ${d?.stage ?? 0}, relevance ${d?.relevance ?? 0}, off-map ${d?.off_map ?? 0}  ` +
          `coverage before ${coverage(map, p.stage, all)} after ${coverage(map, p.stage, out.cards)}${map ? '' : '  [no map]'}${out.held?.flagged ? '  FLAGGED' : ''}\n`,
      );
    }
    process.stdout.write(`\n${rows.length} pools: ${analysed} analysed cards, ${kept} served, ${analysed - kept} held. Under the minimum (refilled, flagged): ${under.length ? under.join(', ') : 'none'}\n`);
  } finally {
    await client.end();
  }
}

main().catch((error: unknown) => {
  process.stderr.write(`discovery:serving-measure failed: ${describeError(error)}\n`);
  process.exitCode = 1;
});
