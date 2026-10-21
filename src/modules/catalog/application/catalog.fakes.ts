import { randomUUID } from 'node:crypto';
import { normaliseTopicText } from '../domain/resolution';
import {
  type CreateLimit,
  type CreateResult,
  type NearTopic,
  type NewTopic,
  type TopicEmbedding,
  type TopicRepository,
  type TopicToEmbed,
  type TopicView,
} from './ports/topic.repository';

export interface FakeTopic extends TopicView {
  slug: string;
  createdBy: string | null;
  createdAt: Date;
  needsReview: boolean;
  domain?: NewTopic['domain'];
  embedding: TopicEmbedding | null;
}

export function cosine(a: number[], b: number[]): number {
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i++) {
    const x = a[i] ?? 0;
    const y = b[i] ?? 0;
    dot += x * y;
    na += x * x;
    nb += y * y;
  }
  return na === 0 || nb === 0 ? 0 : dot / Math.sqrt(na * nb);
}

/** In-memory TopicRepository with exact cosine search, for application tests. */
export class FakeTopicRepository implements TopicRepository {
  readonly topics = new Map<string, FakeTopic>();
  findByIdCalls: string[] = [];

  add(topic: Partial<FakeTopic> & { slug: string; canonicalName: string }): FakeTopic {
    const row: FakeTopic = {
      id: randomUUID(),
      aliases: [],
      parentId: null,
      description: null,
      createdBy: null,
      createdAt: new Date(),
      needsReview: false,
      embedding: null,
      ...topic,
    };
    this.topics.set(row.id, row);
    return row;
  }

  findById(id: string): Promise<TopicView | null> {
    this.findByIdCalls.push(id);
    const t = this.topics.get(id);
    return Promise.resolve(t ? view(t) : null);
  }

  findExact(normalised: string, slug: string): Promise<TopicView[]> {
    const hits = [...this.topics.values()].filter(
      (t) => t.slug === slug || normaliseTopicText(t.canonicalName) === normalised || t.aliases.some((a) => a.toLowerCase() === normalised),
    );
    return Promise.resolve(hits.map(view));
  }

  nearest(query: TopicEmbedding, limit: number): Promise<NearTopic[]> {
    const near = [...this.topics.values()]
      .filter((t) => t.embedding && t.embedding.model === query.model && t.embedding.version === query.version)
      .map((t) => ({ topic: view(t), similarity: cosine(t.embedding?.vector ?? [], query.vector) }))
      .sort((a, b) => b.similarity - a.similarity)
      .slice(0, limit);
    return Promise.resolve(near);
  }

  create(topic: NewTopic, limit: CreateLimit): Promise<CreateResult> {
    const mine = [...this.topics.values()].filter((t) => t.createdBy === topic.createdBy && t.createdAt >= limit.since).length;
    if (mine >= limit.max) return Promise.resolve({ outcome: 'limited' });
    const existing = [...this.topics.values()].find((t) => t.slug === topic.slug);
    if (existing) return Promise.resolve({ outcome: 'exists', topic: view(existing) });
    return Promise.resolve({ outcome: 'created', topic: view(this.add(topic)) });
  }

  countCreatedBy(userId: string, since: Date): Promise<number> {
    return Promise.resolve([...this.topics.values()].filter((t) => t.createdBy === userId && t.createdAt >= since).length);
  }

  listUnembedded(model: string, version: number, limit: number): Promise<TopicToEmbed[]> {
    const rows = [...this.topics.values()]
      .filter((t) => !t.embedding || t.embedding.model !== model || t.embedding.version !== version)
      .slice(0, limit)
      .map(({ id, canonicalName, aliases, description }) => ({ id, canonicalName, aliases, description }));
    return Promise.resolve(rows);
  }

  setEmbedding(id: string, embedding: TopicEmbedding): Promise<void> {
    const t = this.topics.get(id);
    if (t) t.embedding = embedding;
    return Promise.resolve();
  }
}

function view(t: FakeTopic): TopicView {
  return { id: t.id, canonicalName: t.canonicalName, aliases: t.aliases, parentId: t.parentId, description: t.description };
}
