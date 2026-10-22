import { type Tx } from '../../../../shared/db';
import { type Bloom, type CardStatus, type Concept, type PoolStatus, type Quality, type ResourceType, type Stage } from '../../domain';

export const DISCOVERY_REPOSITORY = Symbol('DiscoveryRepository');
export const DISCOVERY_CLOCK = Symbol('DiscoveryClock');
export type Clock = () => Date;

export interface NewResource {
  url: string;
  type: ResourceType;
  title: string;
  source: string;
  youtubeId?: string | null;
  durationMin?: number | null;
  publishedAt?: string | null;
  language?: string | null;
  pageAge?: string | null;
  metadataFetchedAt?: Date | null;
  httpStatus?: number | null;
  checkedAt?: Date | null;
}

export interface ResourceRecord {
  id: string;
  url: string;
  type: ResourceType;
  title: string;
  source: string;
  youtubeId: string | null;
  durationMin: number | null;
  failedChecks: number;
  deadAt: Date | null;
  metadataFetchedAt: Date | null;
}

export interface PoolRecord {
  id: string;
  topicId: string;
  stage: Stage;
  poolVersion: number;
  status: PoolStatus;
  candidateIds: string[];
  analysedIds: string[];
  resourceIds: string[];
  videoFallback: boolean;
  expiresAt: Date;
}

export interface NewCard {
  resourceId: string;
  topicId: string;
  model: string;
  promptVersion: string;
  dreyfusStage: Stage;
  bloomLevels: Bloom[];
  prerequisites: string[];
  concepts: Concept[];
  keyTakeaways: string[];
  whyThis: string | null;
  quality: Quality;
  qualityScore: number;
  confidence: number;
  evidence: string;
  status: CardStatus;
  reviewReason: string | null;
  embedding: { vector: number[]; model: string; version: number } | null;
  expiresAt: Date;
}

/** A card's analysis, reusable for the same URL in another topic (user decision 3, 22 Oct 2026). */
export type ReusableAnalysis = Pick<
  NewCard,
  'model' | 'dreyfusStage' | 'bloomLevels' | 'prerequisites' | 'concepts' | 'keyTakeaways' | 'whyThis' | 'quality' | 'confidence' | 'evidence' | 'embedding'
>;

export interface CardRecord {
  id: string;
  resourceId: string;
  status: CardStatus;
  qualityScore: number;
}

export interface PoolCard {
  resourceId: string;
  type: ResourceType;
  status: CardStatus;
  qualityScore: number;
}

export interface DiscoveryRepository {
  latestPool(topicId: string, stage: Stage): Promise<PoolRecord | null>;
  findPool(topicId: string, stage: Stage, poolVersion: number): Promise<PoolRecord | null>;
  /** Idempotent on (topic, stage, version): a second call returns the existing pool. */
  createPool(tx: Tx, input: { topicId: string; stage: Stage; poolVersion: number; candidateIds: string[]; videoFallback: boolean; expiresAt: Date }): Promise<PoolRecord>;
  /** Inserts new URLs and refreshes YouTube metadata on known ones; returns each URL's resource id. */
  upsertResources(tx: Tx, rows: NewResource[]): Promise<Map<string, string>>;
  getResource(id: string): Promise<ResourceRecord | null>;
  /** The unexpired card for a resource in a topic and prompt version (the L2 cache, PRD-API §10). */
  findCard(resourceId: string, topicId: string, promptVersion: string, now: Date): Promise<CardRecord | null>;
  /** The newest analysis of this resource in this prompt version, in any topic, made since `since`. */
  findRecentAnalysis(resourceId: string, promptVersion: string, since: Date): Promise<ReusableAnalysis | null>;
  /** The closest served card in the topic by cosine similarity, other than `excludeResourceId`'s. */
  nearestServedCard(topicId: string, vector: number[], excludeResourceId: string): Promise<{ card: CardRecord; similarity: number } | null>;
  /** Inserts, or replaces an expired card for the same resource, topic and prompt version. */
  saveCard(tx: Tx, card: NewCard): Promise<string>;
  setCardStatus(tx: Tx, cardId: string, status: CardStatus, reason: string | null): Promise<void>;
  recordAnalysis(tx: Tx, resourceId: string, fields: { readingMin: number | null; language: string }): Promise<void>;
  /** Appends the resource to the pool's analysed ids once, under the row lock; null when it was already there. */
  markAnalysed(tx: Tx, poolId: string, resourceId: string): Promise<PoolRecord | null>;
  /** Cards for the pool's candidates in this prompt version, with their resource's type; dead resources left out. */
  poolCards(tx: Tx, pool: PoolRecord, promptVersion: string): Promise<PoolCard[]>;
  settlePool(tx: Tx, poolId: string, status: Exclude<PoolStatus, 'analysing'>, resourceIds: string[], expiresAt: Date): Promise<void>;
  /** Live resources not checked since `before`, oldest first. */
  dueForLiveness(before: Date, limit: number): Promise<string[]>;
  /** Stores a check; returns true when this check made the resource dead. */
  saveLiveness(resourceId: string, check: { httpStatus: number | null; failedChecks: number; dead: boolean; at: Date }): Promise<boolean>;
  refreshVideo(resourceId: string, video: { title: string; source: string; durationMin: number; publishedAt: string | null; at: Date }): Promise<void>;
}
