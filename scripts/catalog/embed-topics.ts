import { Module } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { EmbedTopics } from '../../src/modules/catalog/application/embed-topics.usecase';
import { CatalogModule } from '../../src/modules/catalog/catalog.module';
import { AiModule } from '../../src/shared/ai';
import { LoggingModule } from '../../src/shared/common/logging';
import { ConfigModule } from '../../src/shared/config';
import { DbModule } from '../../src/shared/db';
import { describeError } from '../../src/shared/db/redact';
import { EventsModule } from '../../src/shared/events';

// Run by the user: `pnpm catalog:embed-topics` (node --env-file-if-exists=.env). Embeds every topic
// without a current gemini-embedding-2 vector, 50 per request, metered in llm_calls (150 topics cost
// well under US$0.01). Idempotent: re-run after a failure, or after an EMBEDDING_VERSION bump.
@Module({ imports: [ConfigModule.forRoot(), LoggingModule, DbModule, EventsModule, AiModule, CatalogModule] })
class EmbedTopicsCliModule {}

async function main(): Promise<void> {
  const app = await NestFactory.createApplicationContext(EmbedTopicsCliModule, { bufferLogs: true });
  try {
    const result = await app.get(EmbedTopics).execute((done) => process.stdout.write(`embedded ${done} topics\n`));
    process.stdout.write(`Done: ${result.embedded} topics in ${result.batches} requests\n`);
  } finally {
    await app.close();
  }
}

main().catch((error: unknown) => {
  process.stderr.write(`catalog:embed-topics failed: ${describeError(error)}\n`);
  process.exitCode = 1;
});
