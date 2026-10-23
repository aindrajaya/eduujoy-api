import { type Bloom, type Concept, type PoolStatus, type Quality, type ResourceType, type Stage } from '../../domain';

export const CARD_READER = Symbol('CardReader');

/** A resource with its latest card for a topic: the contract's public Resource, plus the card's tags. */
export interface ServedCard {
  resourceId: string;
  type: ResourceType;
  url: string;
  youtubeId: string | null;
  title: string;
  source: string;
  durationMin: number | null;
  readingMin: number | null;
  published: string | null;
  language: string;
  stage: Stage;
  bloomLevels: Bloom[];
  prerequisites: string[];
  concepts: Concept[];
  keyTakeaways: string[];
  whyThis: string | null;
  quality: Quality;
  qualityScore: number;
}

export interface PoolSnapshot {
  id: string;
  status: PoolStatus;
  poolVersion: number;
  expiresAt: Date;
  candidates: number;
  analysed: number;
  /** Served resource ids, in the pool's order (empty while analysing). */
  resourceIds: string[];
}

export interface CardReader {
  latestPool(topicId: string, stage: Stage): Promise<PoolSnapshot | null>;
  /** Each resource's latest card for the topic, in the given order; dead resources only if `includeDead`. */
  cards(topicId: string, resourceIds: string[], includeDead: boolean): Promise<ServedCard[]>;
}
