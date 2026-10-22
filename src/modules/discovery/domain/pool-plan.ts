import { type ResourceType, type Stage, type TopicDomain } from './types';

/** The Done-when gate: a topic pool needs at least 3 served resource types. */
export const MIN_POOL_TYPES = 3;
/** PRD-API §10: discovery result sets are shared for 30 days. */
export const POOL_TTL_DAYS = 30;

export type VideoDuration = 'any' | 'medium' | 'long';

export interface PoolPlan {
  /** `search.list` calls (2 per discovery: master PRD §8 cost table). */
  videoSearches: string[];
  videoDuration: VideoDuration;
  /** Longest video kept, in minutes (novices get short videos, master PRD stage mix). */
  maxVideoMin: number;
  maxVideos: number;
  maxWeb: number;
  /** OpenAlex query, or null when papers don't fit the stage. */
  paperQuery: string | null;
  maxPapers: number;
}

const STAGE_WORDS: Record<Stage, { video: [string, string]; paper: boolean; duration: VideoDuration; maxVideoMin: number }> = {
  novice: { video: ['for beginners', 'explained'], paper: false, duration: 'medium', maxVideoMin: 20 },
  advanced_beginner: { video: ['tutorial', 'step by step'], paper: false, duration: 'any', maxVideoMin: 45 },
  // At most VIDEO_MAX_MIN (60) everywhere: longer videos are never analysed (analysis-budget.ts).
  competent: { video: ['in depth', 'best practices'], paper: true, duration: 'any', maxVideoMin: 60 },
  proficient: { video: ['advanced talk', 'internals'], paper: true, duration: 'long', maxVideoMin: 60 },
  expert: { video: ['conference talk', 'research'], paper: true, duration: 'long', maxVideoMin: 60 },
};

/** How one topic and stage is searched; one template per resource type and stage (PRD-API §11). */
export function poolPlan(topicName: string, stage: Stage): PoolPlan {
  const words = STAGE_WORDS[stage];
  return {
    videoSearches: words.video.map((w) => `${topicName} ${w}`),
    videoDuration: words.duration,
    maxVideoMin: words.maxVideoMin,
    maxVideos: 6,
    maxWeb: 9,
    paperQuery: words.paper ? topicName : null,
    maxPapers: 3,
  };
}

/** Where official docs come from for each domain (FR-07). */
export function officialDocRule(domain: TopicDomain | null): string {
  if (domain === 'software') return "the vendor's or project's own documentation domain";
  return 'recognised references: open textbooks, university courseware, standards bodies';
}

export function poolStatus(servedTypes: Iterable<ResourceType>): 'ready' | 'thin' {
  return new Set(servedTypes).size >= MIN_POOL_TYPES ? 'ready' : 'thin';
}
