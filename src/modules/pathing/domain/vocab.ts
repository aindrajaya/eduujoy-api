// Pathing's own copies of the shared vocabularies (the domain layer imports nothing outside it).
export type Stage = 'novice' | 'advanced_beginner' | 'competent' | 'proficient' | 'expert';
export type Bloom = 'C1' | 'C2' | 'C3' | 'C4' | 'C5' | 'C6';
export type ResourceType = 'youtube' | 'article' | 'official_doc' | 'paper' | 'related';

export const STAGES: readonly Stage[] = ['novice', 'advanced_beginner', 'competent', 'proficient', 'expert'];
export const BLOOMS: readonly Bloom[] = ['C1', 'C2', 'C3', 'C4', 'C5', 'C6'];

/** Each Dreyfus stage's Bloom band (master §5 stage table). */
export const BANDS: Record<Stage, { bottom: Bloom; top: Bloom }> = {
  novice: { bottom: 'C1', top: 'C2' },
  advanced_beginner: { bottom: 'C2', top: 'C3' },
  competent: { bottom: 'C3', top: 'C4' },
  proficient: { bottom: 'C4', top: 'C5' },
  expert: { bottom: 'C5', top: 'C6' },
};

/**
 * A path's total estimated time fits this many weeks of the learner's weekly hours (user, 23 Oct
 * 2026: about two weeks, matching the "≥ 4 steps in 14 days" metric).
 */
export const PATH_LENGTH_WEEKS = 2;

export const bloomRank = (b: Bloom): number => BLOOMS.indexOf(b) + 1;

/**
 * The stage a path climbs (master rules 2 and 3): the next stage; novice learners first get a
 * novice-band path (user, 23 Oct 2026) and stage up through its top checkpoint; expert has no next
 * stage and stays expert.
 */
export function targetStage(placed: Stage): Stage {
  if (placed === 'novice' || placed === 'expert') return placed;
  return STAGES[STAGES.indexOf(placed) + 1] as Stage;
}
