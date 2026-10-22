import { type Embedder, EMBEDDING_MODEL, EMBEDDING_VERSION, type EmbeddingRequest } from '../../../shared/ai';
import { FakeTopicRepository } from './catalog.fakes';
import { EMBED_BATCH_SIZE, EmbedTopics } from './embed-topics.usecase';

class CountingEmbedder implements Embedder {
  readonly requests: EmbeddingRequest[] = [];

  embed(request: EmbeddingRequest) {
    this.requests.push(request);
    const call = { provider: 'google' as const, model: EMBEDDING_MODEL, usage: { inputTokens: 1, cacheWriteTokens: 0, cacheReadTokens: 0, outputTokens: 0 }, latencyMs: 1 };
    return Promise.resolve({ vectors: request.texts.map((_, i) => [i, 1]), model: EMBEDDING_MODEL, version: EMBEDDING_VERSION, call });
  }
}

describe('EmbedTopics', () => {
  it('embeds every topic missing a current embedding, in batches, as documents titled by name', async () => {
    const repo = new FakeTopicRepository();
    for (let i = 0; i < EMBED_BATCH_SIZE + 5; i++) repo.add({ slug: `t-${i}`, canonicalName: `Topic ${i}`, aliases: ['alias'], description: 'About it.' });
    repo.add({ slug: 'current', canonicalName: 'Current', embedding: { vector: [1, 0], model: EMBEDDING_MODEL, version: EMBEDDING_VERSION } });
    const stale = repo.add({ slug: 'stale', canonicalName: 'Stale', embedding: { vector: [1, 0], model: EMBEDDING_MODEL, version: EMBEDDING_VERSION - 1 } });
    const embedder = new CountingEmbedder();
    const progress: number[] = [];

    const result = await new EmbedTopics(repo, embedder).execute((n) => progress.push(n));

    expect(result).toEqual({ embedded: EMBED_BATCH_SIZE + 6, batches: 2 });
    expect(progress).toEqual([EMBED_BATCH_SIZE, EMBED_BATCH_SIZE + 6]);
    expect(embedder.requests.map((r) => r.texts.length)).toEqual([EMBED_BATCH_SIZE, 6]);
    expect(embedder.requests[0]).toMatchObject({ stage: 'topic-backfill', kind: 'document', titles: expect.arrayContaining(['Topic 0']) as unknown });
    expect(embedder.requests[0]?.texts[0]).toBe('Topic 0. Also known as: alias. About it.');
    expect(repo.topics.get(stale.id)?.embedding?.version).toBe(EMBEDDING_VERSION);
    await expect(new EmbedTopics(repo, embedder).execute()).resolves.toEqual({ embedded: 0, batches: 0 });
  });

  it('with all, re-embeds every topic under the current version, even ones already current', async () => {
    const repo = new FakeTopicRepository();
    for (let i = 0; i < EMBED_BATCH_SIZE + 3; i++) {
      repo.add({ slug: `c-${i}`, canonicalName: `Current ${i}`, embedding: { vector: [9.5, 9.5], model: EMBEDDING_MODEL, version: EMBEDDING_VERSION } });
    }
    const embedder = new CountingEmbedder();

    const result = await new EmbedTopics(repo, embedder).execute(undefined, { all: true });

    expect(result).toEqual({ embedded: EMBED_BATCH_SIZE + 3, batches: 2 });
    expect([...repo.topics.values()].every((t) => t.embedding?.vector[0] !== 9.5 && t.embedding?.version === EMBEDDING_VERSION)).toBe(true);
    // Without `all`, nothing is stale.
    await expect(new EmbedTopics(repo, embedder).execute()).resolves.toEqual({ embedded: 0, batches: 0 });
  });
});

