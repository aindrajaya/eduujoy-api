import { type TopicDomain } from './topic-normalizer';

export const TOPIC_REPOSITORY = Symbol('TopicRepository');

/** Contract schema Topic. */
export interface TopicView {
  id: string;
  canonicalName: string;
  aliases: string[];
  parentId: string | null;
  description: string | null;
  /** Contract 0.9.0: the topic has a diagnostic item bank. Set by the use cases, not the repository. */
  hasDiagnostic?: boolean;
}

/** What other modules need to work on a topic, beyond the public view (for example discovery queries). */
export interface TopicProfile extends TopicView {
  domain: TopicDomain | null;
}

export interface NearTopic {
  topic: TopicView;
  /** Cosine similarity, 1 - pgvector cosine distance. */
  similarity: number;
  /** For `related` (contract 0.9.0): suggestions stay in the learner's domain. */
  domain: TopicDomain | null;
}

export interface TopicEmbedding {
  vector: number[];
  model: string;
  version: number;
}

export interface NewTopic {
  slug: string;
  canonicalName: string;
  aliases: string[];
  description: string | null;
  domain: TopicDomain | null;
  createdBy: string;
  needsReview: boolean;
  embedding: TopicEmbedding | null;
}

export interface CreateLimit {
  since: Date;
  max: number;
}

export type CreateResult = { outcome: 'created' | 'exists'; topic: TopicView } | { outcome: 'limited' };

export interface TopicToEmbed {
  id: string;
  canonicalName: string;
  aliases: string[];
  description: string | null;
}

export interface TopicRepository {
  findById(id: string): Promise<TopicView | null>;
  findProfile(id: string): Promise<TopicProfile | null>;
  /**
   * Topics whose slug equals `slug`, or whose canonical name or an alias equals `normalised` ignoring case.
   * Like nearest(), only topics `viewerId` may see: a topic flagged needs_review is its creator's alone.
   */
  findExact(normalised: string, slug: string, viewerId: string): Promise<TopicView[]>;
  /**
   * Visible topics whose name or an alias is trigram-similar to `normalised` (pg_trgm, 0..1), best first:
   * the fallback when the embedding provider is down.
   */
  similarNames(normalised: string, minimum: number, limit: number, viewerId: string): Promise<NearTopic[]>;
  /** Nearest visible topics embedded with the same model and version, most similar first. */
  nearest(query: TopicEmbedding, limit: number, viewerId: string): Promise<NearTopic[]>;
  /**
   * Inserts the topic unless its creator already has `limit.max` topics since `limit.since`; the count and
   * the insert are serialised per creator. A slug taken by a visible topic returns that topic; a slug
   * taken by another learner's flagged topic gets a numeric suffix, so flagged text never leaks.
   */
  create(topic: NewTopic, limit: CreateLimit): Promise<CreateResult>;
  countCreatedBy(userId: string, since: Date): Promise<number>;
  /** Topics without an embedding for this model and version, oldest first. */
  listUnembedded(model: string, version: number, limit: number): Promise<TopicToEmbed[]>;
  /** Every topic in id order after `afterId` (keyset paging), for a full re-embed after topic texts change. */
  listAll(afterId: string | null, limit: number): Promise<TopicToEmbed[]>;
  setEmbedding(id: string, embedding: TopicEmbedding): Promise<void>;
}
