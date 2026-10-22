import { Inject, Injectable } from '@nestjs/common';
import { EMBEDDER, type Embedder, EMBEDDING_MODEL, EMBEDDING_VERSION } from '../../../shared/ai';
import { topicDocument } from '../domain/resolution';
import { TOPIC_REPOSITORY, type TopicRepository, type TopicToEmbed } from './ports/topic.repository';

/** Texts per embedding request; well under the provider's per-request limit. */
export const EMBED_BATCH_SIZE = 50;

export interface EmbedTopicsResult {
  embedded: number;
  batches: number;
}

/**
 * Backfills topic embeddings (seeded topics, topics created while Gemini was down, or every topic after
 * an EMBEDDING_VERSION bump). Run by `pnpm catalog:embed-topics`; idempotent, so a failed run resumes.
 * `all` re-embeds every topic under the current version, for when topic texts changed (a seed refine):
 * unlike a version bump, resolve keeps finding every topic while it runs.
 */
@Injectable()
export class EmbedTopics {
  constructor(
    @Inject(TOPIC_REPOSITORY) private readonly topics: TopicRepository,
    @Inject(EMBEDDER) private readonly embedder: Embedder,
  ) {}

  async execute(onBatch: (done: number) => void = () => undefined, options: { all?: boolean } = {}): Promise<EmbedTopicsResult> {
    const seen = new Set<string>();
    let embedded = 0;
    let batches = 0;
    let after: string | null = null;
    for (;;) {
      const page: TopicToEmbed[] = options.all
        ? await this.topics.listAll(after, EMBED_BATCH_SIZE)
        : await this.topics.listUnembedded(EMBEDDING_MODEL, EMBEDDING_VERSION, EMBED_BATCH_SIZE);
      const batch = page.filter((t) => !seen.has(t.id));
      after = page.at(-1)?.id ?? after;
      if (batch.length === 0) return { embedded, batches };
      const docs = batch.map(topicDocument);
      const result = await this.embedder.embed({ stage: 'topic-backfill', kind: 'document', texts: docs.map((d) => d.text), titles: docs.map((d) => d.title) });
      for (const [i, topic] of batch.entries()) {
        const vector = result.vectors[i];
        if (!vector) throw new Error(`Embedder returned ${result.vectors.length} vectors for ${batch.length} topics`);
        await this.topics.setEmbedding(topic.id, { vector, model: result.model, version: result.version });
        // Guards against a loop if a row keeps reporting as unembedded.
        seen.add(topic.id);
      }
      embedded += batch.length;
      batches += 1;
      onBatch(embedded);
    }
  }
}
