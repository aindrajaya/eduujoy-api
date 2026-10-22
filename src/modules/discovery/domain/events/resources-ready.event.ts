import { type PoolStatus, type Stage } from '../types';

/**
 * A topic and stage pool finished analysing (PRD-API §5); pathing enqueues `generate-path`. `thin`
 * pools have fewer than three served resource types.
 */
export class ResourcesReady {
  readonly type = 'ResourcesReady';
  readonly occurredAt = new Date();

  constructor(
    readonly poolId: string,
    readonly topicId: string,
    readonly stage: Stage,
    readonly poolVersion: number,
    readonly status: Exclude<PoolStatus, 'analysing'>,
    readonly resourceIds: string[],
  ) {}
}
