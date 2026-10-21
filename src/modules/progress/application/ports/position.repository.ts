export const POSITION_REPOSITORY = Symbol('PositionRepository');

export interface NewPosition {
  userId: string;
  topicId: string;
  stage: 'novice' | 'advanced_beginner' | 'competent' | 'proficient' | 'expert';
  bloom: 'C1' | 'C2' | 'C3' | 'C4' | 'C5' | 'C6';
  confidence: number;
  source: 'diagnostic' | 'checkpoint' | 'override';
}

export interface PositionRepository {
  /** Append-only: the current position is the latest row per user and topic. */
  append(position: NewPosition): Promise<void>;
}
