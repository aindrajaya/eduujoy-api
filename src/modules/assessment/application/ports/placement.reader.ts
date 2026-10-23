import { type Bloom, type Stage } from '../../domain/diagnostic';

export const PLACEMENT_READER = Symbol('PlacementReader');

/** A placement with the goal, hours and formats from its diagnostic, as a path request needs it. */
export interface PlacementForPath {
  id: string;
  userId: string;
  topicId: string;
  stage: Stage;
  bloom: Bloom;
  goal: string;
  weeklyHours: number;
  preferredFormats: ('video' | 'text' | 'papers')[];
  createdAt: Date;
}

export interface PlacementReader {
  findForPath(placementId: string): Promise<PlacementForPath | null>;
}
