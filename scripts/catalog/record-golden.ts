import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { queryText, topicDocument } from '../../src/modules/catalog/domain/resolution';
import { createGeminiClient, EMBEDDING_MODEL, EMBEDDING_VERSION, GeminiEmbedder } from '../../src/shared/ai/gemini/gemini.adapters';
import { encodeVector, type GoldenEmbeddings } from '../../test/fixtures/catalog/embeddings';

// Run by the user: `pnpm catalog:record-golden` (node --env-file=.env). Embeds the 160 seed topics as
// documents and every golden phrase as a query with gemini-embedding-2, exactly as the API does, and
// saves the vectors to test/fixtures/catalog/embeddings.json so catalog.e2e-spec.ts runs offline.
// About 250 short texts: well under US$0.01. The key comes from process.env only and is never written.

const ROOT = join(__dirname, '..', '..');
const BATCH = 50;

interface SeedTopic {
  canonicalName: string;
  aliases: string[];
  description: string;
}

async function main(): Promise<void> {
  const key = process.env['GEMINI_API_KEY'];
  if (!key) throw new Error('GEMINI_API_KEY must be in the environment (run with node --env-file=.env)');
  const embedder = new GeminiEmbedder(createGeminiClient(key));
  // --holdout (`pnpm catalog:record-holdout`): only the held-out v2 phrases (seed/_eval), as queries; the
  // topic documents stay those of embeddings.json so the tuning recording is never touched. v1 is spent
  // (it failed the launch gate on 22 Oct 2026 and informed the seed refine), so only v2 is recorded.
  const holdout = process.argv.includes('--holdout');

  const seed = JSON.parse(readFileSync(join(ROOT, 'seed', 'topics.json'), 'utf8')) as { topics: SeedTopic[] };
  const casesFile = holdout ? join(ROOT, 'seed', '_eval', 'topic-resolve-holdout-v2.json') : join(ROOT, 'test', 'fixtures', 'catalog', 'golden.json');
  const cases = JSON.parse(readFileSync(casesFile, 'utf8')) as { cases: { text: string }[] };
  const docs = holdout ? [] : seed.topics.map((t) => topicDocument(t));
  const queries = [...new Set(cases.cases.map((c) => queryText(c.text)))];

  const out: GoldenEmbeddings = { model: EMBEDDING_MODEL, version: EMBEDDING_VERSION, recordedAt: new Date().toISOString(), documents: [], queries: [] };
  for (let i = 0; i < docs.length; i += BATCH) {
    const batch = docs.slice(i, i + BATCH);
    const { vectors } = await embedder.embed({ stage: 'record-golden', kind: 'document', texts: batch.map((d) => d.text), titles: batch.map((d) => d.title) });
    batch.forEach((d, j) => out.documents.push({ title: d.title, text: d.text, vector: encodeVector(vectors[j] ?? []) }));
  }
  for (let i = 0; i < queries.length; i += BATCH) {
    const batch = queries.slice(i, i + BATCH);
    const { vectors } = await embedder.embed({ stage: 'record-golden', kind: 'query', texts: batch });
    batch.forEach((text, j) => out.queries.push({ text, vector: encodeVector(vectors[j] ?? []) }));
  }

  const serialized = `${JSON.stringify(out, null, 1)}\n`;
  if (serialized.includes(key)) throw new Error('Refusing to save: output contains the API key');
  writeFileSync(join(ROOT, 'test', 'fixtures', 'catalog', holdout ? 'holdout-v2-embeddings.json' : 'embeddings.json'), serialized);
  process.stdout.write(`saved ${out.documents.length} topic and ${out.queries.length} query embeddings\n`);
}

main().catch((error: unknown) => {
  process.stderr.write(`catalog:record-golden failed: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
