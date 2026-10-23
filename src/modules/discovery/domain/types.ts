// Discovery's own copies of the shared vocabularies (the domain layer imports nothing outside it).
export type Stage = 'novice' | 'advanced_beginner' | 'competent' | 'proficient' | 'expert';
export type Bloom = 'C1' | 'C2' | 'C3' | 'C4' | 'C5' | 'C6';
export type TopicDomain = 'software' | 'stem' | 'non_technical';
/** Master PRD FR-06: Medium and blog posts are `article`; other relevant pages are `related`. */
export type ResourceType = 'youtube' | 'article' | 'official_doc' | 'paper' | 'related';
export type WebResourceType = Extract<ResourceType, 'article' | 'official_doc' | 'related'>;
export type CardStatus = 'served' | 'review' | 'dropped' | 'duplicate';
export type PoolStatus = 'analysing' | 'ready' | 'thin';

export const STAGES: readonly Stage[] = ['novice', 'advanced_beginner', 'competent', 'proficient', 'expert'];
export const BLOOMS: readonly Bloom[] = ['C1', 'C2', 'C3', 'C4', 'C5', 'C6'];

/**
 * The stage a learner's path climbs (A9, user 23 Oct 2026; pathing has its own copy): the next stage,
 * except that novices first consolidate the novice band and experts stay expert.
 */
export function targetStage(placed: Stage): Stage {
  if (placed === 'novice' || placed === 'expert') return placed;
  return STAGES[STAGES.indexOf(placed) + 1] as Stage;
}
