import { randomUUID } from 'node:crypto';
import { normaliseTopicText } from '../domain/resolution';
import {
  type CreateLimit,
  type CreateResult,
  type NearTopic,
  type NewTopic,
  type TopicEmbedding,
  type TopicRepository,
  type TopicProfile,
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

  findProfile(id: string): Promise<TopicProfile | null> {
    const t = this.topics.get(id);
    return Promise.resolve(t ? { ...view(t), domain: t.domain ?? null } : null);
  }

  findExact(normalised: string, slug: string, viewerId: string): Promise<TopicView[]> {
    const hits = [...this.topics.values()].filter(
      (t) => visible(t, viewerId) && (t.slug === slug || normaliseTopicText(t.canonicalName) === normalised || t.aliases.some((a) => a.toLowerCase() === normalised)),
    );
    return Promise.resolve(hits.map(view));
  }

  /** Tests set this to stand in for pg_trgm scores. */
  nameScores = new Map<string, number>();

  similarNames(_normalised: string, minimum: number, limit: number, viewerId: string): Promise<NearTopic[]> {
    const hits = [...this.topics.values()]
      .filter((t) => visible(t, viewerId) && (this.nameScores.get(t.slug) ?? 0) >= minimum)
      .map((t) => ({ topic: view(t), similarity: this.nameScores.get(t.slug) ?? 0, domain: t.domain ?? null }))
      .sort((a, b) => b.similarity - a.similarity)
      .slice(0, limit);
    return Promise.resolve(hits);
  }

  nearest(query: TopicEmbedding, limit: number, viewerId: string): Promise<NearTopic[]> {
    const near = [...this.topics.values()]
      .filter((t) => visible(t, viewerId) && t.embedding && t.embedding.model === query.model && t.embedding.version === query.version)
      .map((t) => ({ topic: view(t), similarity: cosine(t.embedding?.vector ?? [], query.vector), domain: t.domain ?? null }))
      .sort((a, b) => b.similarity - a.similarity)
      .slice(0, limit);
    return Promise.resolve(near);
  }

  create(topic: NewTopic, limit: CreateLimit): Promise<CreateResult> {
    const mine = [...this.topics.values()].filter((t) => t.createdBy === topic.createdBy && t.createdAt >= limit.since).length;
    if (mine >= limit.max) return Promise.resolve({ outcome: 'limited' });
    for (let n = 1; n <= 20; n++) {
      const slug = n === 1 ? topic.slug : `${topic.slug}-${n}`;
      const existing = [...this.topics.values()].find((t) => t.slug === slug);
      if (!existing) return Promise.resolve({ outcome: 'created', topic: view(this.add({ ...topic, slug })) });
      if (visible(existing, topic.createdBy)) return Promise.resolve({ outcome: 'exists', topic: view(existing) });
    }
    return Promise.reject(new Error('no free slug'));
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

  listAll(afterId: string | null, limit: number): Promise<TopicToEmbed[]> {
    const rows = [...this.topics.values()]
      .filter((t) => afterId === null || t.id > afterId)
      .sort((a, b) => a.id.localeCompare(b.id))
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

function visible(t: FakeTopic, viewerId: string): boolean {
  return !t.needsReview || t.createdBy === viewerId;
}

function view(t: FakeTopic): TopicView {
  return { id: t.id, canonicalName: t.canonicalName, aliases: t.aliases, parentId: t.parentId, description: t.description };
}

/** TopicBanks backed by a set of topic ids that have a bank; records each lookup. */
export class FakeTopicBanks {
  readonly lookups: string[][] = [];
  constructor(readonly banked = new Set<string>()) {}

  withBank(topicIds: readonly string[]): Promise<Set<string>> {
    this.lookups.push([...topicIds]);
    return Promise.resolve(new Set(topicIds.filter((id) => this.banked.has(id))));
  }
}
