import { Client } from 'pg';
import { EmbedTopics } from '../../src/modules/catalog/application/embed-topics.usecase';
import { DrizzleTopicRepository } from '../../src/modules/catalog/infrastructure/drizzle-topic.repository';
import { EMBEDDING_MODEL } from '../../src/shared/ai';
import { createGeminiClient, GeminiEmbedder } from '../../src/shared/ai/gemini/gemini.adapters';
import { DrizzleLlmCallRecorder } from '../../src/shared/ai/metering/llm-call.recorder';
import { MeteredEmbedder } from '../../src/shared/ai/metering/metered';
import { createDatabase } from '../../src/shared/db';
import { loadDirectDatabaseUrl } from '../../src/shared/db/cli/env';
import { describeError } from '../../src/shared/db/redact';

// Run by the user: `pnpm catalog:embed-topics` (node --env-file=.env --import tsx). Embeds every topic
// without a current gemini-embedding-2 vector, 50 per request, metered in llm_calls (160 topics cost
// well under US$0.01). Idempotent: re-run after a failure, or after an EMBEDDING_VERSION bump.
// `--all` re-embeds every topic under the current version, after topic texts change (a seed refine);
// resolve keeps working throughout. A failed --all run is simply run again.
// Wired by hand like the db:* CLIs: tsx emits no decorator metadata, so Nest DI can't run under it.

export function buildEmbedTopics(client: Client, geminiApiKey: string): EmbedTopics {
  const db = createDatabase(client);
  const embedder = new MeteredEmbedder(new GeminiEmbedder(createGeminiClient(geminiApiKey)), EMBEDDING_MODEL, new DrizzleLlmCallRecorder(db));
  return new EmbedTopics(new DrizzleTopicRepository(db), embedder);
}

async function main(): Promise<void> {
  const check = process.argv.includes('--check');
  const key = process.env['GEMINI_API_KEY'];
  if (!key && !check) throw new Error('GEMINI_API_KEY must be in the environment (run with node --env-file=.env)');
  const client = new Client({ connectionString: check ? 'postgresql://check@localhost/check' : loadDirectDatabaseUrl() });
  const embedTopics = buildEmbedTopics(client, key ?? 'check');
  // `--check` proves the wiring builds under its runner (test/cli/cli-boot.int-spec.ts) without connecting.
  if (check) {
    process.stdout.write(`catalog:embed-topics: ok (${embedTopics.constructor.name})\n`);
    return;
  }
  await client.connect();
  try {
    const all = process.argv.includes('--all');
    const result = await embedTopics.execute((done) => process.stdout.write(`embedded ${done} topics\n`), { all });
    process.stdout.write(`Done: ${result.embedded} topics in ${result.batches} requests\n`);
  } finally {
    await client.end();
  }
}

main().catch((error: unknown) => {
  process.stderr.write(`catalog:embed-topics failed: ${describeError(error)}\n`);
  process.exitCode = 1;
});
