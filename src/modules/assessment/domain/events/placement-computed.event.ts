import { type Bloom, type Stage } from '../diagnostic/ladder';

/** Emitted after a diagnostic's placement commits (PRD-API §5); progress records the position. */
export class PlacementComputed {
  readonly type = 'PlacementComputed';
  readonly occurredAt = new Date();

  constructor(
    readonly placementId: string,
    readonly userId: string,
    readonly topicId: string,
    readonly stage: Stage,
    readonly bloom: Bloom,
    readonly confidence: number,
    readonly basis: 'items' | 'self_report',
  ) {}
}
